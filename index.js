#!/usr/bin/env node
'use strict';
const meow = require('meow');
const stackTraceParser = require('stacktrace-parser');
const fs = require('fs-extra');
const { basename, join, resolve } = require('path');
const sourceMap = require('source-map');
const { getStdin } = require('get-stdin');

function formatStackFrame(frame) {
  const { file, methodName, lineNumber, column } = frame;
  const parts = [];
  parts.push('at ');
  if (methodName) {
    parts.push(methodName);
  }
  if (file) {
    parts.push(' (');
    parts.push(file);
    if (lineNumber && column) {
      parts.push(':');
      parts.push(column);
      parts.push(':');
      parts.push(lineNumber);
    }
    parts.push(')');
  }

  return parts.join('');
}

class SourceMapRegistry {
  // Map of "basename" -> "fullpath"
  sourceMapFiles = new Map();
  // Map of "basename" -> "source map consumer for source map file"
  sourceMaps = new Map();

  async getSourceMapConsumer(path) {
    const key = basename(path) + '.map';
    const fullPath = this.sourceMapFiles.get(key);

    let smc = this.sourceMaps.get(key);
    if (!smc && fullPath) {
      // Acquire smc
      const mapContent = fs.readJSONSync(fullPath, 'utf-8');
      smc = await new sourceMap.SourceMapConsumer(mapContent);
      this.sourceMaps.set(key, smc);
    }
    return smc;
  }

  initialize(path) {
    this.sourceMapFiles = new Map();
    this.sourceMaps = new Map();

    const stat = fs.lstatSync(path);
    if (stat.isFile()) {
      this.sourceMapFiles.set(basename(path), path);
    } else {
      this.findFiles(path).forEach(each => this.sourceMapFiles.set(basename(each), each));
    }
  }

  findFiles(folder) {
    const results = []

    // Get all files from the folder
    let items = fs.readdirSync(folder);

    // Loop through the results, possibly recurse
    for (const item of items) {
      try {
        const fullPath = join(folder, item)

        if (fs.statSync(fullPath).isDirectory()) {
          // Its a folder, recursively get the child folders' files
          results.push(...(this.findFiles(fullPath)))
        } else {
          // Filter by the file name pattern, if there is one
          if (item.search(new RegExp('.*\.js\.map', 'i')) > -1) {
            results.push(resolve(fullPath))
          }
        }
      } catch (error) {
        // Ignore!
      }
    }

    return results
  }
}

const cli = meow(`
  Usage
    $ stackmapsource <map-path>
 
  Examples
    $ echo "TypeError h is…" | stackmapsource /path/to/source-maps
    
`);

(async () => {
  try {
    // Determine path of source maps
    let mapPath = cli.input[0];
    if (!mapPath) mapPath = process.execPath;

    // Create registry
    const registry = new SourceMapRegistry();
    registry.initialize(mapPath);

    // Acquire stacktrace
    let str = await getStdin();

    // Parse stacktrace
    const stack = stackTraceParser.parse(str);
    if (stack.length === 0) throw new Error('No stack found');

    // Print "header" (usually message of what went wrong, eg. message of Error)
    const header = str.split('\n').find(line => line.trim().length > 0);
    if (header && !header.includes(stack[0].file)) {
      process.stdout.write(`${header}\n`);
    }

    // Translate stacktrace
    for (const each of stack) {
      const { file, methodName, lineNumber, column } = each;
      try {
        if (lineNumber == null || lineNumber < 1) {
          process.stdout.write(`    at ${methodName || ''}\n`);
        } else {
          const smc = await registry.getSourceMapConsumer(file);
          if (smc && typeof smc.originalPositionFor === 'function') {
            const pos = smc && smc.originalPositionFor({ line: lineNumber, column }) || undefined;
            if (pos && pos.line != null) {
              process.stdout.write(`    at ${pos.name || ''} (${pos.source}:${pos.line}:${pos.column})\n`);
            } else {
              process.stdout.write(`    ${formatStackFrame(each)}\n`);
            }
          } else {
            process.stdout.write(`    ${formatStackFrame(each)}\n`);
          }
        }
      } catch (err) {
        process.stdout.write(`    at FAILED_TO_PARSE_LINE\n`, err);
      }
    }
  } catch (err) {
    console.error(err);
  }
})();
