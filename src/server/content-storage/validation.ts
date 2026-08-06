import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import canonicalRevisionSchema from "../../../content-repository/schemas/v1/canonical-revision.schema.json" with { type: "json" };
import repositoryManifestSchema from "../../../content-repository/schemas/v1/repository-manifest.schema.json" with { type: "json" };
import sourceSchema from "../../../content-repository/schemas/v1/source.schema.json" with { type: "json" };
import { hasValidRevisionIdentity, type CanonicalRevision } from "./repository.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(sourceSchema);

const validateRevision = ajv.compile(canonicalRevisionSchema) as ValidateFunction<CanonicalRevision>;
const validateManifest = ajv.compile(repositoryManifestSchema);

export class ContentSchemaValidationError extends Error {
  readonly errors: readonly ErrorObject[];

  constructor(documentName: string, errors: readonly ErrorObject[]) {
    super(`${documentName} does not match a supported content schema: ${ajv.errorsText([...errors])}`);
    this.name = "ContentSchemaValidationError";
    this.errors = errors;
  }
}

export class ContentIntegrityError extends Error {
  constructor() {
    super("Canonical revision content does not match its revisionId and contentHash.");
    this.name = "ContentIntegrityError";
  }
}

export function assertCanonicalRevision(document: unknown): asserts document is CanonicalRevision {
  if (!validateRevision(document)) {
    throw new ContentSchemaValidationError("Canonical revision", validateRevision.errors ?? []);
  }
  if (!hasValidRevisionIdentity(document)) throw new ContentIntegrityError();
}

export function assertRepositoryManifest(document: unknown): void {
  if (!validateManifest(document)) {
    throw new ContentSchemaValidationError("Repository manifest", validateManifest.errors ?? []);
  }
}
