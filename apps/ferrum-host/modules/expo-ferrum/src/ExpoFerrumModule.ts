import { NativeModule, requireNativeModule } from 'expo';

declare class ExpoFerrumModule extends NativeModule {
  getBenchmarkResult(): string;
  getCallOverheadMicros(): number;
}

export default requireNativeModule<ExpoFerrumModule>('ExpoFerrum');
