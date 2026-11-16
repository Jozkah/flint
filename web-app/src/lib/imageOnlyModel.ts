/**
 * A model that only makes pictures: tagged for image generation and not for
 * chat. Chat pickers leave these out; Studio and the picture tools offer them.
 * Kept free of imports so any picker can use it without a cycle.
 */
export const isImageOnlyModel = (model: {
  capabilities?: readonly string[]
}): boolean =>
  !!model.capabilities?.includes('image_generation') &&
  !model.capabilities.includes('completion')
