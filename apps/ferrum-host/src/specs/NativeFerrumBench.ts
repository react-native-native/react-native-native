import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  add(a: number, b: number): number;
  negate(a: boolean): boolean;
  echo(s: string): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FerrumBench');
