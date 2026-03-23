import { Link as RouterLink } from 'expo-router';
import { type ComponentProps, type JSX } from 'react';
import {
  Pressable as RNPressable,
  ScrollView as RNScrollView,
  Text as RNText,
  TextInput as RNTextInput,
  View as RNView,
} from 'react-native';
import { useCssElement, useNativeVariable as useFunctionalVariable } from 'react-native-css';

// CSS-enabled Link
export function Link(
  properties: ComponentProps<typeof RouterLink> & { className?: string }
): JSX.Element {
  // @ts-expect-error: useCssElement produces overly complex union types with RouterLink
  return useCssElement(RouterLink, properties, { className: 'style' });
}

Link.Trigger = RouterLink.Trigger;
Link.Menu = RouterLink.Menu;
Link.MenuAction = RouterLink.MenuAction;
Link.Preview = RouterLink.Preview;

// CSS Variable hook
export const useCSSVariable =
  process.env.EXPO_OS === 'web' ? (variable: string) => `var(${variable})` : useFunctionalVariable;

// View
export type ViewProps = ComponentProps<typeof RNView> & { className?: string };

export function View(properties: ViewProps): JSX.Element {
  return useCssElement(RNView, properties, { className: 'style' });
}

View.displayName = 'CSS(View)';

// Text
export type TextProps = ComponentProps<typeof RNText> & { className?: string };

export function Text(properties: TextProps): JSX.Element {
  return useCssElement(RNText, properties, { className: 'style' });
}

Text.displayName = 'CSS(Text)';

// ScrollView
export type ScrollViewProps = ComponentProps<typeof RNScrollView> & {
  className?: string;
  contentContainerClassName?: string;
};

export function ScrollView(properties: ScrollViewProps): JSX.Element {
  // @ts-expect-error: useCssElement produces overly complex union types with ScrollView
  return useCssElement(RNScrollView, properties, {
    className: 'style',
    contentContainerClassName: 'contentContainerStyle',
  });
}

ScrollView.displayName = 'CSS(ScrollView)';

// Pressable
export type PressableProps = ComponentProps<typeof RNPressable> & { className?: string };

export function Pressable(properties: PressableProps): JSX.Element {
  return useCssElement(RNPressable, properties, { className: 'style' });
}

Pressable.displayName = 'CSS(Pressable)';

// TextInput
export type TextInputProps = ComponentProps<typeof RNTextInput> & { className?: string };

export function TextInput(properties: TextInputProps): JSX.Element {
  return useCssElement(RNTextInput, properties, { className: 'style' });
}

TextInput.displayName = 'CSS(TextInput)';
