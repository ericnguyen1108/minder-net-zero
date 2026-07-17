import { principalForCompetition, principalHasPermission, type ServerPrincipal } from "./auth/context.ts";
import { resolveRequestPlatformContext } from "./auth/request-context.ts";
import { CurrentImportContractError } from "./current-import-contract.ts";
import {
  CurrentImportRepositoryError,
  type CurrentImportRepositoryErrorCode,
} from "./current-import-repository.ts";
import { platformJson, readPlatformJson } from "./http-security.ts";

export class CurrentImportHttpError extends Error {
  readonly code: "body_too_large" | "invalid_json" | "unsupported_media_type";

  constructor(code: CurrentImportHttpError["code"]) {
    super(code);
    this.name = "CurrentImportHttpError";
    this.code = code;
  }
}

export async function readBoundedImportJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CurrentImportHttpError("unsupported_media_type");
  }
  try {
    return await readPlatformJson(request, { maxBytes });
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") {
      throw new CurrentImportHttpError("body_too_large");
    }
    throw new CurrentImportHttpError("invalid_json");
  }
}

export async function authorizeCurrentImport(
  competitionId: string,
): Promise<
  | { ok: true; principal: ServerPrincipal }
  | { ok: false; response: Response }
> {
  const resolution = await resolveRequestPlatformContext();
  if (!resolution.ok) {
    const status = resolution.reason === "unauthenticated" ? 401 : 503;
    return {
      ok: false,
      response: platformJson(
        {
          error: {
            code: status === 401 ? "not_authenticated" : "account_unavailable",
            message: status === 401 ? "Sign in to continue." : "Account access is temporarily unavailable.",
          },
        },
        status,
      ),
    };
  }
  const principal = principalForCompetition(resolution, competitionId);
  if (!principal) {
    return {
      ok: false,
      response: platformJson(
        { error: { code: "resource_not_found", message: "The competition was not found." } },
        404,
      ),
    };
  }
  if (!principalHasPermission(principal, "application.import")) {
    return {
      ok: false,
      response: platformJson(
        { error: { code: "permission_denied", message: "You cannot import applications." } },
        403,
      ),
    };
  }
  return { ok: true, principal };
}

function repositoryStatus(code: CurrentImportRepositoryErrorCode): number {
  if (code === "import_not_found") return 404;
  if (code === "import_expired") return 410;
  if (
    code === "idempotency_conflict" ||
    code === "revision_conflict" ||
    code === "import_closed" ||
    code === "chunk_conflict" ||
    code === "duplicate_external_ref" ||
    code === "source_dataset_conflict"
  ) return 409;
  return 422;
}

export function currentImportErrorResponse(error: unknown): Response {
  if (error instanceof CurrentImportHttpError) {
    const status = error.code === "body_too_large" ? 413 : error.code === "unsupported_media_type" ? 415 : 400;
    return platformJson(
      {
        error: {
          code: error.code,
          message: status === 413 ? "This upload chunk is too large." : "The import request is invalid.",
        },
      },
      status,
    );
  }
  if (error instanceof CurrentImportContractError) {
    const status = error.code === "row_too_large" || error.code === "chunk_too_large" ? 413 : 400;
    return platformJson(
      {
        error: {
          code: error.code,
          message: status === 413 ? "Reduce the chunk size and try again." : "One or more import rows are invalid.",
        },
      },
      status,
    );
  }
  if (error instanceof CurrentImportRepositoryError) {
    const status = repositoryStatus(error.code);
    const message =
      error.code === "revision_conflict"
        ? "This import changed in another session. Reload its status before continuing."
        : error.code === "duplicate_external_ref"
          ? "Every application reference must be unique within the source file."
          : error.code === "import_not_found"
            ? "The import session was not found."
            : status === 410
              ? "This import session expired. Start a new import."
              : status === 409
                ? "The import conflicts with data already received."
                : "The staged import did not match its declared manifest.";
    return platformJson({ error: { code: error.code, message } }, status);
  }
  return platformJson(
    { error: { code: "import_store_unavailable", message: "The central import could not be saved safely." } },
    503,
  );
}
