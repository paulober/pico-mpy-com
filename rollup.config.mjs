import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import json from "@rollup/plugin-json";

const isProduction = process.env.BUILD === 'production';

export default {
    input: isProduction ? 'src/index.ts' : 'src/tests/index.ts',
    output: {
        //dir: 'dist',
        file: isProduction ? 'dist/index.cjs' : 'dist/tests/index.cjs',
        format: 'cjs',
        sourcemap: true
    },
    external: [
        "@serialport/bindings-cpp",
    ],
    plugins: [
        nodeResolve({
            preferBuiltins: true
        }),
        commonjs({
            ignoreDynamicRequires: true,
        }),
        typescript({
            tsconfig: isProduction ? 'tsconfig.json' : 'tsconfig.tests.json',
        }),
        isProduction && terser(),
        json(),
    ],
};
