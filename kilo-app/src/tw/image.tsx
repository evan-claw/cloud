import { Image as RNImage } from 'expo-image';
import { type ComponentProps, type JSX } from 'react';
import { StyleSheet } from 'react-native';
import { useCssElement } from 'react-native-css';
import Animated from 'react-native-reanimated';

const AnimatedExpoImage = Animated.createAnimatedComponent(RNImage);

function CSSImage(properties: ComponentProps<typeof AnimatedExpoImage>) {
  // @ts-expect-error: Remap objectFit style to contentFit property
  const { objectFit, objectPosition, ...style } = StyleSheet.flatten(properties.style) ?? {};

  return (
    <AnimatedExpoImage
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- destructured from ts-expect-error above
      contentFit={objectFit}
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- destructured from ts-expect-error above
      contentPosition={objectPosition}
      {...properties}
      source={
        typeof properties.source === 'string' ? { uri: properties.source } : properties.source
      }
      // @ts-expect-error: Style is remapped above
      style={style}
    />
  );
}

export type ImageProps = ComponentProps<typeof CSSImage> & { className?: string };

export function Image(properties: ImageProps): JSX.Element {
  // @ts-expect-error: useCssElement produces overly complex union types with Image
  return useCssElement(CSSImage, properties, { className: 'style' });
}

Image.displayName = 'CSS(Image)';
