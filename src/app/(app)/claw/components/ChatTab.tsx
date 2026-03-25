'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Channel as StreamChannel, Event } from 'stream-chat';
import {
  Chat,
  Channel,
  Window,
  MessageList,
  MessageInput,
  Thread,
  useCreateChatClient,
  useChatContext,
  useChannelStateContext,
} from 'stream-chat-react';
import { useStreamChatCredentials } from '@/hooks/useKiloClaw';

type ChatTabProps = {
  /** Only fetch credentials and connect when true (tab is active + instance running). */
  enabled: boolean;
};

export function ChatTab({ enabled }: ChatTabProps) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(enabled);

  if (!enabled) {
    return <ChatPlaceholder message="Chat is available when the machine is running." />;
  }

  if (isLoading) {
    return <ChatPlaceholder message="Connecting to chat…" />;
  }

  if (error) {
    return <ChatPlaceholder message="Failed to load chat — please try again." isError />;
  }

  if (!creds) {
    return (
      <ChatPlaceholder message="Chat is not available for this instance. It may have been provisioned before chat was enabled." />
    );
  }

  return <StreamChatUI {...creds} />;
}

// ─── Internal components ────────────────────────────────────────────────────

function StreamChatUI({
  apiKey,
  userId,
  userToken,
  channelId,
}: {
  apiKey: string;
  userId: string;
  userToken: string;
  channelId: string;
}) {
  const client = useCreateChatClient({
    apiKey,
    tokenOrProvider: userToken,
    userData: { id: userId },
  });

  const [channel, setChannel] = useState<StreamChannel | undefined>();

  useEffect(() => {
    if (!client) return;
    const ch = client.channel('messaging', channelId);
    ch.watch({ presence: true });
    setChannel(ch);
  }, [client, channelId]);

  // channelId is "default-{sandboxId}", bot user is "bot-{sandboxId}"
  const sandboxId = channelId.replace(/^default-/, '');
  const botUserId = `bot-${sandboxId}`;

  if (!client || !channel) {
    return <ChatPlaceholder message="Connecting to chat…" />;
  }

  return (
    <div className="claw-chat-wrapper h-[560px]">
      <Chat client={client} theme="str-chat__theme-dark">
        <Channel channel={channel}>
          <Window>
            <BotStatusBar botUserId={botUserId} />
            <MessageList />
            <MessageInput />
          </Window>
          <Thread />
        </Channel>
      </Chat>
    </div>
  );
}

function useBotOnlineStatus(botUserId: string): boolean {
  const { client } = useChatContext();
  const { channel } = useChannelStateContext();

  const getBotOnline = useCallback((): boolean => {
    const member = channel.state.members[botUserId];
    return !!member?.user?.online;
  }, [channel, botUserId]);

  const [online, setOnline] = useState(getBotOnline);

  useEffect(() => {
    setOnline(getBotOnline());

    const handlePresenceChange = (event: Event) => {
      if (event.user?.id === botUserId) {
        setOnline(!!event.user.online);
      }
    };

    client.on('user.presence.changed', handlePresenceChange);
    return () => {
      client.off('user.presence.changed', handlePresenceChange);
    };
  }, [client, botUserId, getBotOnline]);

  return online;
}

function BotStatusBar({ botUserId }: { botUserId: string }) {
  const online = useBotOnlineStatus(botUserId);

  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
      <span
        className={`size-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-white/20'}`}
      />
      <span className="text-xs text-white/50">
        KiloClaw {online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

function ChatPlaceholder({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div
      className={`flex h-96 items-center justify-center text-sm ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {message}
    </div>
  );
}
