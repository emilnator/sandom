import { defaultPngCodec } from '../png-codec.js';
import { transformImageForOutput } from './color-transform.js';
import { buildDisplayP3Profile } from './icc-profile.js';

/** One central color transform, then native-precision PNG sample packing. */
export async function encodePngOutput(descriptor, request) {
  return await encodePngOutputWithCodec(defaultPngCodec, descriptor, request);
}

export async function encodePngOutputWithCodec(codec, descriptor, request) {
  if (request?.format !== 'png') throw new Error('encodePngOutput requires a validated OutputRequest with format "png"');
  const { pixels, width, height } = transformImageForOutput(descriptor, request);
  return await codec.encode(pixels, width, height, {
    bitDepth: request.bitDepth,
    colorEncoding: request.colorEncoding,
    compressionLevel: request.codecOptions.compressionLevel,
    profile: request.colorEncoding.primaries === 'display-p3' ? buildDisplayP3Profile() : null,
    masteringDisplay: request.masteringDisplay,
    contentLightLevel: request.contentLightLevel,
  });
}
