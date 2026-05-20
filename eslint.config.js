'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
    {
        ignores: ['admin/words.js', 'node_modules/**']
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2020,
            globals: {
                ...globals.node,
                ...globals.es2020,
            }
        },
        rules: {
            'indent': ['error', 4, { 'SwitchCase': 1 }],
            'no-console': 'off',
            'no-unused-vars': ['error', { 'ignoreRestSiblings': true, 'argsIgnorePattern': '^_', 'caughtErrorsIgnorePattern': '^_' }],
            'no-var': 'error',
            'no-trailing-spaces': 'error',
            'prefer-const': 'error',
            'quotes': ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': true }],
            'semi': ['error', 'always']
        }
    },
    {
        files: ['test/**/*.js', '**/*.test.js'],
        languageOptions: {
            globals: {
                ...globals.mocha
            }
        }
    },
    prettierConfig
];
