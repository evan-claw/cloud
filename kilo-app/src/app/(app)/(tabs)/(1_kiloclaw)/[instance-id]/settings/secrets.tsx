import { Check, ChevronDown, ChevronUp, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useKiloClawMutations, useKiloClawSecretCatalog } from '@/lib/hooks/use-kiloclaw';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type CatalogSecret = NonNullable<ReturnType<typeof useKiloClawSecretCatalog>['data']>[number];

function SecretCard({
  secret,
  mutations,
}: Readonly<{
  secret: CatalogSecret;
  mutations: ReturnType<typeof useKiloClawMutations>;
}>) {
  const colors = useThemeColors();
  const [expanded, setExpanded] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const isSaving = mutations.patchSecrets.isPending;

  const filledFields = secret.fields.filter(f => (fieldValues[f.key] ?? '').trim().length > 0);
  const canSave = secret.allFieldsRequired
    ? filledFields.length === secret.fields.length
    : filledFields.length > 0;

  function handleSave() {
    const secrets: Record<string, string> = {};
    for (const f of secret.fields) {
      const val = (fieldValues[f.key] ?? '').trim();
      if (val) secrets[f.key] = val;
    }
    mutations.patchSecrets.mutate(
      { secrets },
      {
        onSuccess: () => {
          setFieldValues({});
          setExpanded(false);
          toast.success(`${secret.label} saved`);
        },
      }
    );
  }

  function handleRemove() {
    Alert.alert(
      'Remove Secret',
      `Remove ${secret.label}? This tool will lose access to its credentials.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            const secrets: Record<string, null> = {};
            for (const f of secret.fields) {
              // eslint-disable-next-line unicorn/no-null -- tRPC schema requires null for secret removal
              secrets[f.key] = null;
            }
            mutations.patchSecrets.mutate({ secrets });
          },
        },
      ]
    );
  }

  return (
    <View className="rounded-lg bg-secondary mx-4 overflow-hidden">
      {/* Header row */}
      <View className="flex-row items-center gap-3 px-4 py-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-medium">{secret.label}</Text>
          {secret.helpText && (
            <Text className="text-xs text-muted-foreground">{secret.helpText}</Text>
          )}
        </View>
        {secret.configured ? (
          <View className="rounded-full bg-green-500/15 px-2 py-0.5">
            <Text className="text-xs font-medium text-green-600 dark:text-green-400">
              Connected
            </Text>
          </View>
        ) : (
          <View className="rounded-full bg-muted px-2 py-0.5">
            <Text className="text-xs text-muted-foreground">Not connected</Text>
          </View>
        )}
      </View>

      {/* Action buttons */}
      <View className={`flex-row gap-2 px-4 ${expanded ? 'pb-2' : 'pb-3'}`}>
        {secret.configured ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onPress={() => {
                setExpanded(prev => !prev);
              }}
            >
              {expanded ? (
                <ChevronUp size={14} color={colors.foreground} />
              ) : (
                <ChevronDown size={14} color={colors.foreground} />
              )}
              <Text className="text-xs">{expanded ? 'Cancel' : 'Update Token'}</Text>
            </Button>
            <Button variant="destructive" size="sm" onPress={handleRemove}>
              <Trash2 size={14} color="white" />
              <Text className="text-xs text-destructive-foreground">Remove</Text>
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onPress={() => {
              setExpanded(prev => !prev);
            }}
          >
            {expanded ? (
              <ChevronUp size={14} color={colors.foreground} />
            ) : (
              <ChevronDown size={14} color={colors.foreground} />
            )}
            <Text className="text-xs">{expanded ? 'Cancel' : 'Connect'}</Text>
          </Button>
        )}
      </View>

      {/* Expandable token input area */}
      {expanded && (
        <Animated.View entering={FadeIn.duration(150)}>
          <View className="px-4 pb-3 gap-3">
            {secret.allFieldsRequired && secret.fields.length > 1 && (
              <Text className="text-xs text-muted-foreground">
                All fields are required to connect {secret.label}.
              </Text>
            )}
            {secret.fields.map(field => (
              <View key={field.key} className="gap-1.5">
                <Text className="text-xs font-medium text-muted-foreground">{field.label}</Text>
                <TextInput
                  className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
                  placeholder={secret.configured ? field.placeholderConfigured : field.placeholder}
                  placeholderTextColor={colors.mutedForeground}
                  defaultValue={fieldValues[field.key] ?? ''}
                  onChangeText={val => {
                    setFieldValues(prev => ({ ...prev, [field.key]: val }));
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  returnKeyType="done"
                />
              </View>
            ))}
            <Button size="sm" disabled={!canSave || isSaving} onPress={handleSave}>
              {isSaving ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Check size={14} color={colors.primaryForeground} />
              )}
              <Text className="text-xs text-primary-foreground">
                {isSaving ? 'Saving…' : 'Save'}
              </Text>
            </Button>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

export default function SecretsScreen() {
  const mutations = useKiloClawMutations();
  const catalogQuery = useKiloClawSecretCatalog();
  const isLoading = catalogQuery.isPending;
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardWillShow', e => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Secrets" />
      <View className="flex-1">
        <ScrollView
          contentContainerClassName="pt-4 gap-3"
          contentInset={{ bottom: keyboardHeight > 0 ? keyboardHeight + 10 : 0 }}
          scrollIndicatorInsets={{ bottom: keyboardHeight > 0 ? keyboardHeight + 10 : 0 }}
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          {isLoading ? (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-4">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.duration(200)} className="gap-3">
              {catalogQuery.data?.map(secret => (
                <SecretCard key={secret.id} secret={secret} mutations={mutations} />
              ))}
            </Animated.View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
