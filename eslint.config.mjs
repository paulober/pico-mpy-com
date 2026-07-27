import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,

  {
    files: ["src/**/*.ts"],
    ignores: ["dist/**", "out/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      globals: {
        ...globals.node,
        ...globals.es6,
        ...globals.commonjs,
      },
    },
    rules: {
      "@typescript-eslint/naming-convention": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
      "@typescript-eslint/no-unsafe-return": "off",

      semi: "off",
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      "no-mixed-requires": "error",
      "no-this-before-super": "warn",
      "no-unreachable": "warn",
      "no-unused-vars": "off",
      "max-len": ["warn", { code: 80, comments: 100, ignoreComments: false }],
      "no-fallthrough": "warn",
      "newline-before-return": "warn",
      "no-return-await": "warn",
      "arrow-body-style": ["error", "as-needed"],
      "no-unexpected-multiline": "error",
      "prefer-const": "warn",
    },
  },
];
