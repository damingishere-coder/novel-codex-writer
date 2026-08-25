import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import type { ApiStreamError } from "../shared/api-contract.ts";
import { getErrorCode, getErrorMessage, redactErrorMessage, sendError, sendNdjson } from "./http-error.ts";

interface RouteDefinition {
  path: string;
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
  streamErrors?: boolean;
}

export function registerNovelLibraryRoutes(
  server: ViteDevServer,
  validateRequest: (req: IncomingMessage) => void,
  routes: RouteDefinition[]
) {
  server.middlewares.use("/api", (req, res, next) => {
    try {
      validateRequest(req);
      next();
    } catch (error) {
      sendError(res, error);
    }
  });

  for (const route of routes) {
    server.middlewares.use(route.path, async (req, res) => {
      try {
        await route.handler(req, res);
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        if (route.streamErrors && res.headersSent) {
          const event = {
            type: "error",
            code: getErrorCode(error),
            message: redactErrorMessage(getErrorMessage(error))
          } satisfies ApiStreamError;
          sendNdjson(res, event, true);
          return;
        }
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        sendError(res, error);
      }
    });
  }
}
