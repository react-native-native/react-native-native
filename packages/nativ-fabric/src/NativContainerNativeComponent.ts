import type { ViewProps } from "react-native";
import { codegenNativeComponent } from "react-native";

interface NativContainerProps extends ViewProps {
  componentId: string;
  propsJson?: string;
}

export default codegenNativeComponent<NativContainerProps>("NativContainer");
