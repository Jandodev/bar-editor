declare module 'three/examples/jsm/controls/OrbitControls' {
  import { Camera, Vector3, EventDispatcher } from 'three';

  export class OrbitControls extends EventDispatcher {
    constructor(object: Camera, domElement?: HTMLElement);
    enabled: boolean;
    enableDamping: boolean;
    target: Vector3;
    update(): boolean;
    dispose(): void;
  }
}
