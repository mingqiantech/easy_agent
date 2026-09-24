import type { z } from "zod";
export function zodToJsonSchema(
  schema: z.ZodType<any>,
): Record<string, unknown> {
  const def = (schema as any)._def;
  if (!def) return { type: "object" };
  switch (def.typeName) {
    case "ZodString":
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
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "zodArray":
      return { type: "array", items: zodToJsonSchema(def.type) };
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodType);
        if ((value as any)._def.typeName !== "ZodOptional") required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    default:
      return { type: "object" };
  }
}
