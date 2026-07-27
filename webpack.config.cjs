//@ts-check

'use strict';

const path = require('node:path');

//@ts-ignore
module.exports = (_env, argv) => {
  const buildMode = _env.build || argv.mode || 'production'; // 'production' or 'development'
  const isProduction = buildMode === 'production';

  /** @type {import('webpack').Configuration} */
  const config = {
    name: 'pico-mpy-com',
    target: 'node',
    mode: isProduction ? 'production' : 'development',
    entry: isProduction ? './src/index.ts' : './src/tests/index.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProduction ? 'index.cjs' : 'tests/index.cjs',
      libraryTarget: 'commonjs2',
      clean: true,
    },

    devtool: 'source-map',

    externals: {
      '@serialport/bindings-cpp': 'commonjs2 @serialport/bindings-cpp',
    },

    resolve: {
      extensions: ['.ts', '.js', '.json'],
      extensionAlias: {
        '.js': ['.ts', '.js'],
        '.cjs': ['.cts', '.cjs'],
        '.mjs': ['.mts', '.mjs'],
      },
    },

    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              configFile: isProduction ? 'tsconfig.json' : 'tsconfig.tests.json',
            },
          },
        },
        // JSON is handled natively by webpack 5, no loader required
        {
          test: /\.json$/,
          type: 'json',
        },
      ],
    },

    optimization: {
      minimize: isProduction,
    },

    node: {
      __dirname: false,
      __filename: false,
    }
  };

  return [config];
};
