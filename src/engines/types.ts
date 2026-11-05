import type { LngLat } from '../geo';

export interface CameraPose {
  lng: number;
  lat: number;
  heading: number; // degrees, 0 = north
  pitch: number; // degrees, negative looks down
  agl: number; // camera height above ground, meters
  back: number; // meters the camera trails behind the walker (third-person follow)
}

/** A renderer of the real world. Both engines take the same camera pose every frame. */
export interface ViewEngine {
  readonly label: string;
  init(el: HTMLElement, start: LngLat): Promise<void>;
  render(pose: CameraPose, dt: number): void;
  setRoute(coords: LngLat[]): void;
  /** True once there is something real to show. */
  ready(): boolean;
  destroy(): void;
  /** The walker's predicted next ~24 m, so imagery can be fetched before you get there. */
  prefetch?(path: LngLat[]): void;
  /** 0 (lightest) .. 3 (sharpest); driven by measured frame rate so it runs well on any phone. */
  setQuality?(level: number): void;
  /** False when there is no imagery near the camera (Real View). */
  coverage?(): boolean;
  /** Max look-around angle (degrees) the current imagery supports. */
  lookRange?(): number;
  /** Real View is always at eye level; camera heights don't apply. */
  readonly eyeLevelOnly?: boolean;
}
