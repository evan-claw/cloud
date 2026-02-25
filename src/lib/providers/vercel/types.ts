import * as z from 'zod';

export const ModelSchema = z.object({ id: z.string(), name: z.string() });

export const ModelsSchema = z.object({ data: z.array(ModelSchema) });

export const EndpointSchema = z.object({ provider_name: z.string() });

export const EndpointsSchema = z.object({
  data: z.object({ endpoints: z.array(EndpointSchema) }),
});

export const StoredModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  providers: z.array(z.string()),
});

export type StoredModel = z.infer<typeof StoredModelSchema>;
