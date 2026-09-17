import { parentPort } from "node:worker_threads";
import { Parsers } from "./index.js";
import { AppError } from "@secondmind/core";
parentPort!.on("message", async (message) => {
  try {
    parentPort!.postMessage({
      result: await new Parsers(message.maxChars).parse(
        message.bytes,
        message.name,
      ),
    });
  } catch (error) {
    parentPort!.postMessage({
      error:
        error instanceof AppError
          ? error.message
          : "Unable to parse this document. Check its format.",
      code: error instanceof AppError ? error.code : "parser_failure",
    });
  }
});
