import { TurboModuleRegistry } from 'react-native';

const cache: Record<string, any> = {};

export function enableFerrum() {
  const originalGet = TurboModuleRegistry.get.bind(TurboModuleRegistry);
  const originalGetEnforcing = TurboModuleRegistry.getEnforcing.bind(TurboModuleRegistry);

  function getFerrumModule(name: string) {
    if (cache[name] !== undefined) return cache[name];
    if (!(global as any).__ferrumGetModule) return null;
    const mod = (global as any).__ferrumGetModule(name);
    if (mod) cache[name] = mod;
    return mod;
  }

  (TurboModuleRegistry as any).get = (name: string) => {
    return getFerrumModule(name) || originalGet(name);
  };

  (TurboModuleRegistry as any).getEnforcing = (name: string) => {
    return getFerrumModule(name) || originalGetEnforcing(name);
  };
}
