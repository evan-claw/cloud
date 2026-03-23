'use client';

import { useEffect, useState } from 'react';
import type { Channel as StreamChannel } from 'stream-chat';
import {
  Chat,
  Channel,
  Window,
  ChannelHeader,
  MessageList,
  MessageInput,
  Thread,
  useCreateChatClient,
} from 'stream-chat-react';
import { useStreamChatCredentials } from '@/hooks/useKiloClaw';

type ChatTabProps = {
  /** Only fetch credentials and connect when true (tab is active + instance running). */
  enabled: boolean;
};

export function ChatTab({ enabled }: ChatTabProps) {
  const { data: creds, isLoading, error } = useStreamChatCredentials(enabled);

  if (!enabled) return null;

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
    setChannel(ch);
  }, [client, channelId]);

  if (!client || !channel) {
    return <ChatPlaceholder message="Connecting to chat…" />;
  }

  return (
    <div className="claw-chat-wrapper h-[560px]">
      <Chat client={client} theme="str-chat__theme-dark">
        <Channel channel={channel}>
          <Window>
            <ChannelHeader />
            <MessageList />
            <MessageInput />
          </Window>
          <Thread />
        </Channel>
      </Chat>
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
