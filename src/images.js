/** Shared PNG codec adapter. Native samples and source metadata are retained. */
import { validateImageDescriptor } from './image-data.js';
import { defaultPngCodec } from './png-codec.js';

export async function decodePNG(bytes) {
  return validateImageDescriptor(await defaultPngCodec.decode(bytes));
}
