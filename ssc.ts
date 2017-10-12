#!/usr/bin/env node

import * as fs from 'fs';
import * as util from 'util';
import * as path from 'path';
import * as minimist from 'minimist';

import * as driver from "./src/driver";
import { Error } from "./src/error";
import * as llvm from 'llvmc';

const STDIN_FILENAME = '-';  // Indicates we should read from stdin.
const EXTENSION = '.ss';

function run(filename: string, source: string, webgl: boolean,
    compile: boolean, execute: boolean, test: boolean,
    generate: boolean, log: (...msg: any[]) => void, presplice: boolean,
    native: boolean, outfile: string)
{
  let success = true;
  let name = path.basename(filename, EXTENSION);

  try {

    // Configure the driver.
    let config: driver.Config = {
      webgl: webgl,
      native: native,
      generate: generate,

      log: log,
      error: e => {
        if (test) {
          success = driver.check_output(name, source, e.toString());
        } else {
          console.error(e.toString());
          success = false;
        }
      },

      parsed: (_ => void 0),
      typed: (_ => void 0),

      presplice,
    };

    let sources: string[] = [source];
    let filenames: string[] = [filename];

    let res = driver.frontend(config, sources, filenames);
    if (res instanceof Error) {
      if (test) {
        return driver.check_output(name, source, res.toString());
      } else {
        console.error(res.toString());
        return false;
      }
    }

    let [tree, types] = res;
    if (compile) {

      let if_to_js = (code: string) => {
        if (execute) {
          driver.execute(config, code, (res) => {
            if (test) {
              success = driver.check_output(name, source, res);
            } else {
              console.log(res);
            }
          });
        } else {
          console.log(code);
        }
      }

      let if_to_native = (mod: llvm.Module) => {
        console.log(mod.toString());
      }

      // Compiler.
      driver.compile(config, tree, types, if_to_js, if_to_native);

    } else {
      // Interpreter.
      driver.interpret(config, tree, types, (res) => {
        if (test) {
          success = driver.check_output(name, source, res);
        } else {
          console.log(res);
        }
      });
    }

  } catch (e) {

    if (test) {
      // Avoid crashing the test harness.
      let name = path.basename(filename, EXTENSION);
      console.log(`${name} ✘: unhandled error`);
      console.error(e.stack || e);
      success = false;
    } else {
      throw e;
    }

  }

  return success;
}

/**
 * Dump a lot of debugging information using Node's `util.inspect`.
 */
function verbose_log(...msg: any[]) {
  let out: string[] = [];
  for (let m of msg) {
    if (typeof(m) === "string") {
      out.push(m);
    } else if (m instanceof Array) {
      for (let i = 0; i < m.length; ++i) {
        out.push("\n" + i + ": " +
            util.inspect(m[i], { depth: undefined, colors: true }));
      }
    } else {
      out.push(util.inspect(m, { depth: undefined, colors: true }));
    }
  }
  // Work around a TypeScript limitation:
  // https://github.com/Microsoft/TypeScript/issues/4755
  console.log(out[0], ...out.slice(1));
}

/**
 * Read from a file or, if the filename is "-", from stdin.
 */
function read_file_or_stdin(fn: string): Promise<string> {
  return new Promise(function (resolve, reject) {
    if (fn === STDIN_FILENAME) {
      // Read from stdin.
      let chunks: string[] = [];
      process.stdin.on("data", (chunk: string) => {
        chunks.push(chunk);
      }).on("end", () => {
        resolve(chunks.join(""));
      }).setEncoding("utf8");
    } else {
      // Read from a file.
      fs.readFile(fn, (err, data) => {
        if (err) {
          reject(err);
        }
        resolve(data.toString());
      });
    }
  });
}

async function main() {
  // Parse the command-line options.
  let args = minimist(process.argv.slice(2), {
    boolean: ['v', 'c', 'x', 'w', 't', 'g', 'P', 'n'],
    string: ['o'],
  });

  // The flags: -v, -c, and -x.
  let verbose: boolean = args['v'];
  let compile: boolean = args['c'];
  let execute: boolean = args['x'];
  let webgl: boolean = args['w'];
  let test: boolean = args['t'];
  let generate: boolean = args['g'];
  let no_presplice: boolean = args['P'];
  let native: boolean = args['n'];
  let outfile: string = args['o'];

  // Help.
  if (args['h'] || args['help'] || args['?']) {
    console.error("usage: " + process.argv[1] + " [-vcxwtgP] [PROGRAM...]");
    console.error("  -v: verbose mode");
    console.error("  -c: compile (as opposed to interpreting)");
    console.error("  -x: execute the program (use with -c)");
    console.error("  -w: use the WebGL language variant");
    console.error("  -t: test mode (check for expected output)");
    console.error("  -g: dump generated code");
    console.error("  -P: do not use the presplicing optimization");
    console.error("  -n: use native (LLVM) backend");
    console.error("  -o FILE: emit result in FILE");
    process.exit(1);
  }

  // Get the program filenames, or indicate that we'll read code from STDIN.
  let filenames: string[] = args._;
  if (!filenames.length) {
    filenames = [STDIN_FILENAME];
  }

  // Log stuff, if in verbose mode.
  let log = verbose ? verbose_log : (() => void 0);

  // Read each source file and run the driver.
  let success = true;
  await Promise.all(filenames.map(async fn => {
    let source = await read_file_or_stdin(fn);
    success = run(fn, source, webgl, compile, execute, test,
        generate, log, !no_presplice, native, outfile) && success;
  }));
  if (!success) {
    process.exit(1);
  }
}

main();
