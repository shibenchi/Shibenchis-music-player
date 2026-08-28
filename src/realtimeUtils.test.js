import {
  buildSharedPlayerUpdate,
  getSharedResumeTime,
  isConversationVisible,
  markConversationPreviewEntriesRead,
  upsertConversationPreviewEntries
} from './realtimeUtils';

describe('realtimeUtils', () => {
  test('treats a conversation as visible only on the social tab', () => {
    expect(isConversationVisible('social', 'user-2', 'user-2')).toBe(true);
    expect(isConversationVisible('main', 'user-2', 'user-2')).toBe(false);
    expect(isConversationVisible('social', 'user-3', 'user-2')).toBe(false);
  });

  test('updates conversation previews and only increments unread when requested', () => {
    const firstMessage = {
      sender_id: 'user-2',
      receiver_id: 'user-1',
      sender_username: 'shibtest1',
      receiver_username: 'shibtest2',
      message: 'first ping',
      created_at: '2026-04-11T10:00:00.000Z'
    };

    const secondMessage = {
      ...firstMessage,
      message: 'second ping',
      created_at: '2026-04-11T10:01:00.000Z'
    };

    const afterUnread = upsertConversationPreviewEntries([], firstMessage, 'user-1', true);
    expect(afterUnread).toHaveLength(1);
    expect(afterUnread[0].last_message).toBe('first ping');
    expect(afterUnread[0].unread_count).toBe(1);

    const afterVisible = upsertConversationPreviewEntries(afterUnread, secondMessage, 'user-1', false);
    expect(afterVisible[0].last_message).toBe('second ping');
    expect(afterVisible[0].unread_count).toBe(1);
  });

  test('marks only the targeted conversation preview as read', () => {
    const previews = [
      { user_id: 'user-2', unread_count: 3, last_message: 'hello' },
      { user_id: 'user-3', unread_count: 1, last_message: 'yo' }
    ];

    const next = markConversationPreviewEntriesRead(previews, 'user-2');
    expect(next[0].unread_count).toBe(0);
    expect(next[1].unread_count).toBe(1);
  });

  test('prefers live audio time only when local shared playback should override', () => {
    expect(getSharedResumeTime({
      audioCurrentTime: 83.25,
      requestedTime: 42,
      fallbackCurrentTime: 0
    })).toBe(83.25);

    expect(getSharedResumeTime({
      audioCurrentTime: undefined,
      requestedTime: 42,
      fallbackCurrentTime: 0
    })).toBe(42);

    expect(getSharedResumeTime({
      audioCurrentTime: 0,
      requestedTime: 42,
      fallbackCurrentTime: 0
    })).toBe(42);

    expect(getSharedResumeTime({
      audioCurrentTime: 83.25,
      requestedTime: 42,
      fallbackCurrentTime: 0,
      allowAudioOverride: false
    })).toBe(42);
  });

  test('builds shared player updates from audio state with safe fallbacks', () => {
    expect(buildSharedPlayerUpdate({
      currentTrackId: 'track-1',
      audioCurrentTime: 12.5,
      audioVolume: 0.75,
      isAudioPaused: false,
      fallbackCurrentTime: 1,
      fallbackVolume: 1
    })).toEqual({
      current_track_id: 'track-1',
      is_playing: true,
      current_time: 12.5,
      volume: 0.75
    });

    expect(buildSharedPlayerUpdate({
      currentTrackId: 'track-1',
      audioCurrentTime: undefined,
      audioVolume: undefined,
      isAudioPaused: true,
      fallbackCurrentTime: 33,
      fallbackVolume: 0.5
    })).toEqual({
      current_track_id: 'track-1',
      is_playing: false,
      current_time: 33,
      volume: 0.5
    });
  });
});
