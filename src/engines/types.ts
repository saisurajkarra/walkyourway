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
  /** Fraction 0..1 of nearby detail loaded, for the loading veil. */
  ready(): boolean;
  destroy(): void;
}
