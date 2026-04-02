/**
 * kotlin-daemon.js — persistent Kotlin compiler daemon.
 *
 * Starts a long-running JVM with the Kotlin compiler warm in memory.
 * Communication via a simple TCP socket (sync-friendly from Node).
 * First compile: ~3-5s (class loading). Subsequent compiles: ~1-2s.
 */

const { spawn, execSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

let _daemon = null;
let _port = null;

const DAEMON_PORT_FILE = '/tmp/ferrum-kotlin-daemon.port';

/**
 * Start the Kotlin compiler daemon. Called once when Metro starts.
 */
function startDaemon(projectRoot) {
  if (_daemon) return;

  const gradleCache = path.join(process.env.HOME || '', '.gradle/caches/modules-2/files-2.1');
  const findJar = (group, artifact) => {
    try {
      return execSync(
        `find "${gradleCache}/${group}/${artifact}" -name "*.jar" -not -name "*sources*" -not -name "*javadoc*" 2>/dev/null | sort -V | tail -1`,
        { encoding: 'utf8' }
      ).trim();
    } catch { return ''; }
  };

  const embeddableJars = [
    findJar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable'),
    findJar('org.jetbrains.kotlin', 'kotlin-stdlib'),
    findJar('org.jetbrains.kotlin', 'kotlin-script-runtime'),
    findJar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
    findJar('org.jetbrains.intellij.deps', 'trove4j'),
    findJar('org.jetbrains', 'annotations'),
  ].filter(Boolean);

  if (embeddableJars.length < 3) {
    console.warn('[ferrum] Kotlin JARs not found — daemon not started');
    return;
  }

  // Find d8.jar to include in daemon (avoids separate JVM for dex conversion)
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(process.env.HOME || '', 'Library/Android/sdk');
  let d8Jar = null;
  try {
    const btDir = path.join(androidHome, 'build-tools');
    const versions = fs.readdirSync(btDir).sort();
    if (versions.length > 0) {
      const candidate = path.join(btDir, versions[versions.length - 1], 'lib/d8.jar');
      if (fs.existsSync(candidate)) d8Jar = candidate;
    }
  } catch {}

  // Write the daemon Java source
  const daemonDir = path.join(projectRoot, '.ferrum/daemon');
  fs.mkdirSync(daemonDir, { recursive: true });
  const srcPath = path.join(daemonDir, 'KotlinDaemon.java');
  fs.writeFileSync(srcPath, DAEMON_JAVA);

  // Use the full (non-embeddable) compiler if available — needed for compiler API
  // (KotlinCoreEnvironment uses un-shaded com.intellij.* classes)
  const fullCompiler = path.join(projectRoot, '.ferrum/compose-pretransform/kotlin-compiler-2.1.20.jar');
  const compilerJars = fs.existsSync(fullCompiler)
    ? [daemonDir, fullCompiler, ...embeddableJars.filter(j => !j.includes('kotlin-compiler-embeddable'))]
    : [daemonDir, ...embeddableJars];
  if (d8Jar) compilerJars.push(d8Jar);
  const jvmCp = compilerJars.join(':');

  // Compile + start in background — doesn't block Metro startup
  const classFile = path.join(daemonDir, 'KotlinDaemon.class');
  const needsCompile = !fs.existsSync(classFile) ||
    fs.statSync(srcPath).mtimeMs > fs.statSync(classFile).mtimeMs;

  const launch = () => {
    console.log('[ferrum] Starting Kotlin compiler daemon...');
    _daemon = spawn('java', [
      '-Xmx1g',
      '-XX:+UseG1GC',
      '-XX:ReservedCodeCacheSize=256m',
      '-cp', jvmCp,
      'KotlinDaemon',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    wireUpDaemon();
  };

  if (needsCompile) {
    // Compile async, then launch
    const javacCp = fs.existsSync(fullCompiler) ? fullCompiler : embeddableJars[0];
    const javac = spawn('javac', ['-cp', javacCp, srcPath, '-d', daemonDir], {
      stdio: 'pipe',
    });
    javac.on('close', (code) => {
      if (code === 0) launch();
      else console.error('[ferrum] Failed to compile Kotlin daemon');
    });
  } else {
    // Already compiled — launch immediately (still async via spawn)
    launch();
  }

  function wireUpDaemon() {
    _daemon.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[kotlin-daemon]', s.slice(0, 200));
    });
    _daemon.stdout.on('data', (d) => {
      const s = d.toString().trim();
      if (s.startsWith('PORT:')) {
        _port = parseInt(s.split(':')[1]);
        fs.writeFileSync(DAEMON_PORT_FILE, String(_port));
        console.log(`[ferrum] Kotlin daemon ready on port ${_port}`);
      }
    });
    _daemon.on('exit', (code) => {
      console.log(`[ferrum] Kotlin daemon exited (${code})`);
      _daemon = null;
      _port = null;
      try { fs.unlinkSync(DAEMON_PORT_FILE); } catch {}
    });
  }
}

/**
 * Compile a .kt file via the daemon. SYNCHRONOUS (for Metro transformer).
 * @param {Object} request - { sourceFile, outputDir, classpath, plugin? }
 * @returns {{ success: boolean, error?: string }}
 */
function compileSyncViaDaemon(request) {
  if (!_port) {
    // Try reading port from file (in case daemon started in parent process)
    try {
      _port = parseInt(fs.readFileSync(DAEMON_PORT_FILE, 'utf8'));
    } catch {}
  }
  if (!_port) return null;

  const reqJson = JSON.stringify(request);

  // Write request to temp file, send via nc (netcat)
  const reqFile = `/tmp/ferrum-kt-req-${process.pid}.json`;
  fs.writeFileSync(reqFile, reqJson + '\n');

  try {
    const result = execSync(
      `nc -w 120 127.0.0.1 ${_port} < "${reqFile}"`,
      { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    try { fs.unlinkSync(reqFile); } catch {}
    return JSON.parse(result);
  } catch (e) {
    try { fs.unlinkSync(reqFile); } catch {}
    return { success: false, error: e.message?.slice(0, 200) };
  }
}

function stopDaemon() {
  if (_daemon) {
    try { _daemon.kill(); } catch {}
    _daemon = null;
    _port = null;
    try { fs.unlinkSync(DAEMON_PORT_FILE); } catch {}
  }
}

function isDaemonReady() {
  if (_port) return true;
  // Check port file (daemon started in main process, we're in a worker)
  try {
    _port = parseInt(fs.readFileSync(DAEMON_PORT_FILE, 'utf8'));
    return _port > 0;
  } catch { return false; }
}

// ─── Daemon Java source (TCP server) ──────────────────────────────────

const DAEMON_JAVA = String.raw`
import java.io.*;
import java.net.*;
import java.util.*;

public class KotlinDaemon {
    public static void main(String[] args) throws Exception {
        ServerSocket server = new ServerSocket(0); // random port
        int port = server.getLocalPort();
        System.out.println("PORT:" + port);
        System.out.flush();

        // Pre-warm: compile with FULL classpath (android.jar + stdlib) to warm
        // the JIT for classpath scanning, type resolution, and IR lowering.
        // A trivial warmup doesn't help — need android imports to exercise real codepaths.
        try {
            java.io.File warmup = java.io.File.createTempFile("warmup", ".kt");
            warmup.deleteOnExit();
            java.io.FileWriter fw = new java.io.FileWriter(warmup);
            fw.write("import android.view.View\nimport android.widget.TextView\n" +
                     "import android.widget.FrameLayout\nimport android.graphics.Color\n" +
                     "fun _warmup(ctx: android.content.Context) {\n" +
                     "  val tv = TextView(ctx); tv.text = \"hi\"; tv.setTextColor(Color.WHITE)\n" +
                     "  val fl = FrameLayout(ctx); fl.addView(tv)\n}\n");
            fw.close();
            java.io.File warmupOut = java.io.File.createTempFile("warmup-out", "");
            warmupOut.delete(); warmupOut.mkdirs(); warmupOut.deleteOnExit();

            // Build classpath: find android.jar and kotlin-stdlib from JVM classpath
            String fullCp = System.getProperty("java.class.path");
            String androidJar = "", stdlibJar = "";
            for (String p : fullCp.split(":")) {
                if (p.contains("android.jar") || p.contains("platforms/android")) androidJar = p;
                if (p.contains("kotlin-stdlib") && !p.contains("script")) stdlibJar = p;
            }
            // If no android.jar on daemon classpath, try common location
            if (androidJar.isEmpty()) {
                String home = System.getProperty("user.home");
                java.io.File aj = new java.io.File(home + "/Library/Android/sdk/platforms/android-36/android.jar");
                if (aj.exists()) androidJar = aj.getAbsolutePath();
            }
            String warmupCp = androidJar + ":" + stdlibJar;

            long t = System.currentTimeMillis();
            for (int i = 0; i < 3; i++) {
                var c = new org.jetbrains.kotlin.cli.jvm.K2JVMCompiler();
                org.jetbrains.kotlin.cli.common.CLICompiler.doMainNoExit(c, new String[]{
                    warmup.getAbsolutePath(), "-d", warmupOut.getAbsolutePath(),
                    "-classpath", warmupCp, "-no-reflect", "-jvm-target", "17"
                });
            }
            System.err.println("Kotlin daemon: JIT warmup done in " +
                (System.currentTimeMillis() - t) + "ms (3 compiles with android.jar)");

            // Also warm d8 if available
            try {
                Class.forName("com.android.tools.r8.D8");
                System.err.println("Kotlin daemon: d8 class loaded");
            } catch (Exception ignore) {}
        } catch (Exception e) {
            System.err.println("Warmup failed: " + e.getMessage());
        }

        while (true) {
            try {
                Socket client = server.accept();
                BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream()));
                PrintWriter out = new PrintWriter(client.getOutputStream(), true);

                String line = in.readLine();
                if (line == null || line.isEmpty()) { client.close(); continue; }

                String result = compile(line);
                out.println(result);
                client.close();
            } catch (Exception e) {
                // keep running
            }
        }
    }

    // Reuse compiler instance — internal caches may persist
    static final org.jetbrains.kotlin.cli.jvm.K2JVMCompiler sharedCompiler =
        new org.jetbrains.kotlin.cli.jvm.K2JVMCompiler();

    // ─── Compile ───────────────────────────────────────────────────────
    static String compile(String json) {
        try {
            String sourceFile = extract(json, "sourceFile");
            String outputDir = extract(json, "outputDir");
            String classpath = extract(json, "classpath");
            String plugin = extract(json, "plugin");
            String dexOutput = extract(json, "dexOutput");
            String androidJar = extract(json, "androidJar");

            long t0 = System.currentTimeMillis();

            // Build compiler args
            List<String> argList = new ArrayList<>();
            argList.add(sourceFile);
            argList.add("-d"); argList.add(outputDir);
            argList.add("-classpath"); argList.add(classpath);
            argList.add("-no-reflect"); argList.add("-jvm-target"); argList.add("17");
            if (plugin != null && !plugin.isEmpty()) {
                argList.add("-Xplugin=" + plugin);
            }

            PrintStream oldErr = System.err;
            ByteArrayOutputStream errBuf = new ByteArrayOutputStream();
            System.setErr(new PrintStream(errBuf));

            var compiler = new org.jetbrains.kotlin.cli.jvm.K2JVMCompiler();
            var exit = org.jetbrains.kotlin.cli.common.CLICompiler.doMainNoExit(
                compiler, argList.toArray(new String[0]));
            long kotlincMs = System.currentTimeMillis() - t0;

            System.setErr(oldErr);

            if (exit != org.jetbrains.kotlin.cli.common.ExitCode.OK) {
                String err = errBuf.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
                return "{\"success\":false,\"error\":\"" + err + "\"}";
            }

            // Step 2: d8 → .dex
            long d8Ms = 0;
            if (dexOutput != null && !dexOutput.isEmpty()) {
                try {
                    long t1 = System.currentTimeMillis();
                    List<String> classFiles = new ArrayList<>();
                    findClassFiles(new java.io.File(outputDir), classFiles);

                    List<String> d8Args = new ArrayList<>();
                    d8Args.add("--output");
                    d8Args.add(new java.io.File(dexOutput).getParent());
                    d8Args.add("--min-api"); d8Args.add("24");
                    d8Args.add("--no-desugaring");
                    if (androidJar != null && !androidJar.isEmpty()) {
                        d8Args.add("--lib"); d8Args.add(androidJar);
                    }
                    d8Args.addAll(classFiles);

                    Class<?> d8Class = Class.forName("com.android.tools.r8.D8");
                    d8Class.getMethod("main", String[].class)
                        .invoke(null, (Object) d8Args.toArray(new String[0]));

                    java.io.File classesDex = new java.io.File(
                        new java.io.File(dexOutput).getParent(), "classes.dex");
                    if (classesDex.exists()) classesDex.renameTo(new java.io.File(dexOutput));

                    d8Ms = System.currentTimeMillis() - t1;
                } catch (Exception e) {
                    return "{\"success\":false,\"error\":\"d8: " +
                        (e.getMessage() != null ? e.getMessage().replace("\"", "\\\"") : "unknown") + "\"}";
                }
            }

            return "{\"success\":true,\"kotlincMs\":" + kotlincMs + ",\"d8Ms\":" + d8Ms + "}";
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage().replace("\"", "\\\"") : "unknown";
            return "{\"success\":false,\"error\":\"" + msg + "\"}";
        }
    }

    static void findClassFiles(java.io.File dir, List<String> result) {
        java.io.File[] files = dir.listFiles();
        if (files == null) return;
        for (java.io.File f : files) {
            if (f.isDirectory()) findClassFiles(f, result);
            else if (f.getName().endsWith(".class")) result.add(f.getAbsolutePath());
        }
    }

    static String extract(String json, String key) {
        String search = "\"" + key + "\":\"";
        int start = json.indexOf(search);
        if (start < 0) return null;
        start += search.length();
        int end = json.indexOf("\"", start);
        if (end < 0) return null;
        return json.substring(start, end).replace("\\\\", "\\").replace("\\\"", "\"");
    }
}
`;

module.exports = { startDaemon, compileSyncViaDaemon, stopDaemon, isDaemonReady };
