import { Color, DataTexture, DoubleSide, FrontSide, ShaderMaterial, SRGBColorSpace } from 'three';
import type { MapMode } from './camera';
import type { RGB } from './theme';
import { LON0 } from './view';

/** Sample surface colours from geographic coordinates rather than triangle UVs. */
export function surfaceMaterial(rgb: RGB, mode: MapMode, texture: DataTexture | null = null): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      surface: { value: texture },
      hasSurface: { value: texture !== null },
      globe: { value: mode === 'globe' },
      centralLongitude: { value: LON0 * Math.PI / 180 },
      baseColor: { value: new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace) },
    },
    vertexShader: `
      varying vec3 surfacePosition;
      void main() {
        surfacePosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D surface;
      uniform bool hasSurface;
      uniform bool globe;
      uniform float centralLongitude;
      uniform vec3 baseColor;
      varying vec3 surfacePosition;
      const float PI = 3.141592653589793;
      float derivative(float t) {
        float t2 = t * t, t6 = t2 * t2 * t2;
        return 1.340264 - 0.243318 * t2 + t6 * (0.006251 + 0.034164 * t2);
      }
      vec2 geographicUV() {
        float longitude, latitude;
        if (globe) {
          vec3 p = normalize(surfacePosition);
          longitude = atan(p.x, p.z);
          latitude = asin(clamp(p.y, -1.0, 1.0));
        } else {
          vec2 p = surfacePosition.xy * PI / 180.0;
          float theta = p.y;
          for (int i = 0; i < 7; i++) {
            float t2 = theta * theta, t6 = t2 * t2 * t2;
            float y = theta * (1.340264 - 0.081106 * t2 + t6 * (0.000893 + 0.003796 * t2));
            theta -= (y - p.y) / derivative(theta);
          }
          longitude = centralLongitude + p.x * derivative(theta) / (1.1547005383792515 * cos(theta));
          latitude = asin(clamp(sin(theta) / 0.8660254037844386, -1.0, 1.0));
        }
        return vec2(longitude / (2.0 * PI) + 0.5, latitude / PI + 0.5);
      }
      void main() {
        gl_FragColor = vec4(hasSurface ? texture2D(surface, geographicUV()).rgb : baseColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false, depthWrite: false,
    side: mode === 'globe' ? FrontSide : DoubleSide,
  });
}
