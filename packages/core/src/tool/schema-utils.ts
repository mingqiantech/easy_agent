import type { z } from "zod";
export function zodToJsonSchema(
  schema: z.ZodType<any>,
): Record<string, unknown> {
  const def = (schema as any)._def;
  if (!def) return { type: "object" };
  switch (def.typeName) {
    case "ZzodString":
      return {
        type: "string",
        ...(def.description ? { description: def.description } : {}),
      };
    case "ZodNumber":
      return {
        type: "number",
        ...(def.description ? { description: def.description } : {}),
      };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
  }
}
