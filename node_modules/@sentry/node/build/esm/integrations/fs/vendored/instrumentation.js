import { context } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition, isWrapped } from '@opentelemetry/instrumentation';
import { SDK_VERSION, startInactiveSpan, suppressTracing, SPAN_STATUS_ERROR, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, SEMANTIC_ATTRIBUTE_SENTRY_OP, startSpan } from '@sentry/core';
import { promisify } from 'util';
import { SYNC_FUNCTIONS, CALLBACK_FUNCTIONS, PROMISE_FUNCTIONS } from './constants.js';
import { indexFs } from './utils.js';

const PACKAGE_NAME = "@sentry/instrumentation-fs";
const SPAN_ORIGIN = "auto.file.fs";
const SPAN_OP = "file";
const FS_OPERATIONS_WITH_OLD_PATH_NEW_PATH = ["rename", "renameSync"];
const FS_OPERATIONS_WITH_SRC_DEST = ["copyFile", "cp", "copyFileSync", "cpSync"];
const FS_OPERATIONS_WITH_EXISTING_PATH_NEW_PATH = ["link", "linkSync"];
const FS_OPERATIONS_WITH_PREFIX = ["mkdtemp", "mkdtempSync"];
const FS_OPERATIONS_WITH_TARGET_PATH = ["symlink", "symlinkSync"];
const FS_OPERATIONS_WITH_PATH_ARG = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "exists",
  "mkdir",
  "lchown",
  "lstat",
  "lutimes",
  "open",
  "opendir",
  "readdir",
  "readFile",
  "readlink",
  "realpath",
  "realpath.native",
  "rm",
  "rmdir",
  "stat",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "existsSync",
  "lchownSync",
  "lstatSync",
  "lutimesSync",
  "opendirSync",
  "mkdirSync",
  "openSync",
  "readdirSync",
  "readFileSync",
  "readlinkSync",
  "realpathSync",
  "realpathSync.native",
  "rmdirSync",
  "rmSync",
  "statSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync"
];
function getSpanAttributes(functionName, args, config) {
  const attributes = {
    [SEMANTIC_ATTRIBUTE_SENTRY_OP]: SPAN_OP,
    [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: SPAN_ORIGIN
  };
  if (!config.recordFilePaths) {
    return attributes;
  }
  if (typeof args[0] === "string" && FS_OPERATIONS_WITH_PATH_ARG.includes(functionName)) {
    attributes["path_argument"] = args[0];
  } else if (typeof args[0] === "string" && typeof args[1] === "string") {
    if (FS_OPERATIONS_WITH_TARGET_PATH.includes(functionName)) {
      attributes["target_argument"] = args[0];
      attributes["path_argument"] = args[1];
    } else if (FS_OPERATIONS_WITH_EXISTING_PATH_NEW_PATH.includes(functionName)) {
      attributes["existing_path_argument"] = args[0];
      attributes["new_path_argument"] = args[1];
    } else if (FS_OPERATIONS_WITH_SRC_DEST.includes(functionName)) {
      attributes["src_argument"] = args[0];
      attributes["dest_argument"] = args[1];
    } else if (FS_OPERATIONS_WITH_OLD_PATH_NEW_PATH.includes(functionName)) {
      attributes["old_path_argument"] = args[0];
      attributes["new_path_argument"] = args[1];
    }
  } else if (typeof args[0] === "string" && FS_OPERATIONS_WITH_PREFIX.includes(functionName)) {
    attributes["prefix_argument"] = args[0];
  }
  return attributes;
}
function patchedFunctionWithOriginalProperties(patchedFunction, original) {
  return Object.assign(patchedFunction, original);
}
class FsInstrumentation extends InstrumentationBase {
  constructor(config = {}) {
    super(PACKAGE_NAME, SDK_VERSION, config);
  }
  init() {
    return [
      new InstrumentationNodeModuleDefinition(
        "fs",
        ["*"],
        (fs) => {
          for (const fName of SYNC_FUNCTIONS) {
            const { objectToPatch, functionNameToPatch } = indexFs(fs, fName);
            if (isWrapped(objectToPatch[functionNameToPatch])) {
              this._unwrap(objectToPatch, functionNameToPatch);
            }
            this._wrap(objectToPatch, functionNameToPatch, this._patchSyncFunction.bind(this, fName));
          }
          for (const fName of CALLBACK_FUNCTIONS) {
            const { objectToPatch, functionNameToPatch } = indexFs(fs, fName);
            if (isWrapped(objectToPatch[functionNameToPatch])) {
              this._unwrap(objectToPatch, functionNameToPatch);
            }
            if (fName === "exists") {
              this._wrap(objectToPatch, functionNameToPatch, this._patchExistsCallbackFunction.bind(this, fName));
              continue;
            }
            this._wrap(objectToPatch, functionNameToPatch, this._patchCallbackFunction.bind(this, fName));
          }
          for (const fName of PROMISE_FUNCTIONS) {
            if (isWrapped(fs.promises[fName])) {
              this._unwrap(fs.promises, fName);
            }
            this._wrap(fs.promises, fName, this._patchPromiseFunction.bind(this, fName));
          }
          return fs;
        },
        (fs) => {
          if (fs === void 0) return;
          for (const fName of SYNC_FUNCTIONS) {
            const { objectToPatch, functionNameToPatch } = indexFs(fs, fName);
            if (isWrapped(objectToPatch[functionNameToPatch])) {
              this._unwrap(objectToPatch, functionNameToPatch);
            }
          }
          for (const fName of CALLBACK_FUNCTIONS) {
            const { objectToPatch, functionNameToPatch } = indexFs(fs, fName);
            if (isWrapped(objectToPatch[functionNameToPatch])) {
              this._unwrap(objectToPatch, functionNameToPatch);
            }
          }
          for (const fName of PROMISE_FUNCTIONS) {
            if (isWrapped(fs.promises[fName])) {
              this._unwrap(fs.promises, fName);
            }
          }
        }
      ),
      new InstrumentationNodeModuleDefinition(
        "fs/promises",
        ["*"],
        (fsPromises) => {
          for (const fName of PROMISE_FUNCTIONS) {
            if (isWrapped(fsPromises[fName])) {
              this._unwrap(fsPromises, fName);
            }
            this._wrap(fsPromises, fName, this._patchPromiseFunction.bind(this, fName));
          }
          return fsPromises;
        },
        (fsPromises) => {
          if (fsPromises === void 0) return;
          for (const fName of PROMISE_FUNCTIONS) {
            if (isWrapped(fsPromises[fName])) {
              this._unwrap(fsPromises, fName);
            }
          }
        }
      )
    ];
  }
  _patchSyncFunction(functionName, original) {
    const instrumentation = this;
    const patchedFunction = function(...args) {
      const config = instrumentation.getConfig();
      const attributes = getSpanAttributes(functionName, args, config);
      return startSpan({ name: `fs.${functionName}`, onlyIfParent: true, attributes }, (span) => {
        try {
          return suppressTracing(() => original.apply(this, args));
        } catch (error) {
          recordError(span, error, config);
          throw error;
        }
      });
    };
    return patchedFunctionWithOriginalProperties(patchedFunction, original);
  }
  _patchCallbackFunction(functionName, original) {
    const instrumentation = this;
    const patchedFunction = function(...args) {
      const config = instrumentation.getConfig();
      const lastIdx = args.length - 1;
      const cb = args[lastIdx];
      if (typeof cb !== "function") {
        return original.apply(this, args);
      }
      const attributes = getSpanAttributes(functionName, args, config);
      const span = startInactiveSpan({ name: `fs.${functionName}`, onlyIfParent: true, attributes });
      args[lastIdx] = context.bind(context.active(), function(...cbArgs) {
        const error = cbArgs[0];
        if (error) {
          recordError(span, error, config);
        }
        span.end();
        return cb.apply(this, cbArgs);
      });
      try {
        return suppressTracing(() => original.apply(this, args));
      } catch (error) {
        recordError(span, error, config);
        span.end();
        throw error;
      }
    };
    return patchedFunctionWithOriginalProperties(patchedFunction, original);
  }
  _patchExistsCallbackFunction(functionName, original) {
    const instrumentation = this;
    const patchedFunction = function(...args) {
      const config = instrumentation.getConfig();
      const lastIdx = args.length - 1;
      const cb = args[lastIdx];
      if (typeof cb !== "function") {
        return original.apply(this, args);
      }
      const attributes = getSpanAttributes(functionName, args, config);
      const span = startInactiveSpan({ name: `fs.${functionName}`, onlyIfParent: true, attributes });
      args[lastIdx] = context.bind(context.active(), function(...cbArgs) {
        span.end();
        return cb.apply(this, cbArgs);
      });
      try {
        return suppressTracing(() => original.apply(this, args));
      } catch (error) {
        recordError(span, error, config);
        span.end();
        throw error;
      }
    };
    const functionWithOriginalProperties = patchedFunctionWithOriginalProperties(patchedFunction, original);
    const promisified = function(path) {
      return new Promise((resolve) => functionWithOriginalProperties(path, resolve));
    };
    Object.defineProperty(promisified, "name", { value: functionName });
    Object.defineProperty(functionWithOriginalProperties, promisify.custom, {
      value: promisified
    });
    return functionWithOriginalProperties;
  }
  _patchPromiseFunction(functionName, original) {
    const instrumentation = this;
    const patchedFunction = async function(...args) {
      const config = instrumentation.getConfig();
      const attributes = getSpanAttributes(functionName, args, config);
      return startSpan({ name: `fs.${functionName}`, onlyIfParent: true, attributes }, async (span) => {
        try {
          return await suppressTracing(() => original.apply(this, args));
        } catch (error) {
          recordError(span, error, config);
          throw error;
        }
      });
    };
    return patchedFunctionWithOriginalProperties(patchedFunction, original);
  }
}
function recordError(span, error, config) {
  span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
  if (config.recordErrorMessagesAsSpanAttributes && error instanceof Error) {
    span.setAttribute("fs_error", error.message);
  }
}

export { FsInstrumentation };
//# sourceMappingURL=instrumentation.js.map
