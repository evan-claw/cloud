import { useEffect, useRef } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type RenameInstanceModalProps = {
  visible: boolean;
  defaultName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

export function RenameInstanceModal({
  visible,
  defaultName,
  onSubmit,
  onClose,
}: Readonly<RenameInstanceModalProps>) {
  const colors = useThemeColors();
  const nameRef = useRef(defaultName);

  useEffect(() => {
    if (visible) {
      nameRef.current = defaultName;
    }
  }, [visible, defaultName]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <Pressable className="flex-1 justify-center px-6" onPress={onClose}>
          <View className="absolute inset-0 bg-black opacity-50" />
          <Pressable
            className="rounded-xl bg-card p-5 gap-4"
            onPress={e => {
              e.stopPropagation();
            }}
          >
            <Text className="text-base font-semibold">Rename Instance</Text>
            <TextInput
              key={defaultName}
              className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
              placeholder="Enter a new name (max 50 characters)"
              placeholderTextColor={colors.mutedForeground}
              defaultValue={defaultName}
              onChangeText={val => {
                nameRef.current = val;
              }}
              autoFocus
              maxLength={50}
            />
            <View className="flex-row justify-end gap-3">
              <Button variant="outline" onPress={onClose}>
                <Text>Cancel</Text>
              </Button>
              <Button
                onPress={() => {
                  const trimmed = nameRef.current.trim();
                  if (trimmed) {
                    onSubmit(trimmed);
                  }
                  onClose();
                }}
              >
                <Text className="text-primary-foreground">Save</Text>
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
