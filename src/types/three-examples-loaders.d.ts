declare module 'three/examples/jsm/loaders/DDSLoader' {
  import type { LoadingManager, CompressedTexture } from 'three';

  export class DDSLoader {
    constructor(manager?: LoadingManager);
    load(
      url: string,
      onLoad?: (texture: CompressedTexture) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): CompressedTexture;
    setCrossOrigin(crossOrigin: string): this;
    setPath(path: string): this;
  }
}
