const { getDefaultConfig } = require('expo/metro-config');
const { withReactNativeNative } = require('@react-native-native/nativ-fabric/metro');

module.exports = withReactNativeNative(getDefaultConfig(__dirname));
