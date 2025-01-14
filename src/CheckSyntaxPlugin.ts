import fs from 'node:fs';
import { resolve } from 'node:path';
import type { Rspack } from '@rsbuild/core';
import { parse } from 'acorn';
import { browserslistToESVersion } from 'browserslist-to-es-version';
import { generateError } from './generateError.js';
import { generateHtmlScripts } from './generateHtmlScripts.js';
import { printErrors } from './printErrors.js';
import type {
  AcornParseError,
  CheckSyntaxExclude,
  CheckSyntaxOptions,
  ECMASyntaxError,
  EcmaVersion,
} from './types.js';
import { checkIsExclude } from './utils.js';

type Compiler = Rspack.Compiler;
type Compilation = Rspack.Compilation;

const HTML_REGEX = /\.html$/;
export const JS_REGEX: RegExp = /\.(?:js|mjs|cjs|jsx)$/;

export class CheckSyntaxPlugin {
  errors: ECMASyntaxError[] = [];

  ecmaVersion: EcmaVersion;

  targets: string[];

  rootPath: string;

  exclude: CheckSyntaxExclude | undefined;

  excludeOutput: CheckSyntaxExclude | undefined;

  constructor(
    options: CheckSyntaxOptions &
      Required<Pick<CheckSyntaxOptions, 'targets'>> & {
        rootPath: string;
      },
  ) {
    this.targets = options.targets;
    this.exclude = options.exclude;
    this.excludeOutput = options.excludeOutput;
    this.rootPath = options.rootPath;
    this.ecmaVersion =
      options.ecmaVersion || browserslistToESVersion(this.targets);
  }

  apply(compiler: Compiler): void {
    compiler.hooks.afterEmit.tapPromise(
      CheckSyntaxPlugin.name,
      async (compilation: Compilation) => {
        const outputPath = compilation.outputOptions.path || 'dist';

        // not support compilation.emittedAssets in Rspack
        const emittedAssets = compilation
          .getAssets()
          .filter((a) => a.source)
          .map((a) => {
            // remove query from name
            const resourcePath = a.name.split('?')[0];
            const file = resolve(outputPath, resourcePath);
            if (!checkIsExclude(file, this.excludeOutput)) {
              return file;
            }
            return '';
          });

        const files = emittedAssets.filter(
          (assets) => HTML_REGEX.test(assets) || JS_REGEX.test(assets),
        );
        await Promise.all(
          files.map(async (file) => {
            await this.check(file);
          }),
        );

        printErrors(this.errors, this.ecmaVersion);
      },
    );
  }

  private async check(filepath: string) {
    if (HTML_REGEX.test(filepath)) {
      const htmlScripts = await generateHtmlScripts(filepath);
      await Promise.all(
        htmlScripts.map(async (script) => {
          if (!checkIsExclude(filepath, this.exclude)) {
            await this.tryParse(filepath, script);
          }
        }),
      );
    }

    if (JS_REGEX.test(filepath)) {
      const jsScript = await fs.promises.readFile(filepath, 'utf-8');
      await this.tryParse(filepath, jsScript);
    }
  }

  private async tryParse(filepath: string, code: string) {
    try {
      parse(code, { ecmaVersion: this.ecmaVersion });
    } catch (_: unknown) {
      const err = _ as AcornParseError;

      const error = await generateError({
        err,
        code,
        filepath,
        exclude: this.exclude,
        rootPath: this.rootPath,
      });

      if (error) {
        this.errors.push(error);
      }
    }
  }
}
