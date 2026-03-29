const { withAppDelegate, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Config plugin that injects FerrumRuntimeFactory into the Expo app.
 *
 * 1. Adds createJSRuntimeFactory override to ReactNativeDelegate
 * 2. Adds jsrt_create_ferrum_factory declaration to bridging header
 */
function withFerrumFactory(config) {
  // Patch AppDelegate.swift
  config = withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;

    // Add createJSRuntimeFactory override to ReactNativeDelegate
    if (!contents.includes("createJSRuntimeFactory")) {
      contents = contents.replace(
        "class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {",
        `class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Ferrum: replace default Hermes factory with FerrumRuntimeFactory
  override func createJSRuntimeFactory() -> UnsafeMutableRawPointer {
    return jsrt_create_ferrum_factory()
  }
`
      );
    }

    config.modResults.contents = contents;
    return config;
  });

  // Patch bridging header
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;
      const appName = config.modRequest.projectName || "ferrumhost";
      const headerPath = path.join(
        projectRoot,
        appName,
        `${appName}-Bridging-Header.h`
      );

      if (fs.existsSync(headerPath)) {
        let contents = fs.readFileSync(headerPath, "utf8");
        if (!contents.includes("jsrt_create_ferrum_factory")) {
          contents += "\nvoid *jsrt_create_ferrum_factory(void);\n";
          fs.writeFileSync(headerPath, contents);
        }
      }

      return config;
    },
  ]);

  return config;
}

module.exports = withFerrumFactory;
