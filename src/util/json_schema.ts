/**
 * Minimal JSON Schema types for tool parameter definitions.
 *
 * NOTE: property names here follow the JSON Schema wire format on purpose
 * (properties, required, additionalProperties) because these objects are
 * serialized verbatim into LLM provider requests. Do not snake_case them.
 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}