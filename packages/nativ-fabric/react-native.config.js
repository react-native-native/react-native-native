module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: __dirname + '/NativFabric.podspec',
      },
      android: {
        packageImportPath: 'import com.nativfabric.NativContainerPackage;',
        packageInstance: 'new NativContainerPackage()',
      },
    },
  },
};
