export function isConversationVisible(activeTab, selectedConversationId, conversationId) {
  return activeTab === 'social' && !!conversationId && selectedConversationId === conversationId;
}

export function upsertConversationPreviewEntries(prevEntries, message, currentUserId, countAsUnread = false) {
  if (!message?.sender_id || !message?.receiver_id) {
    return prevEntries;
  }

  const otherUserId = message.sender_id === currentUserId ? message.receiver_id : message.sender_id;
  const otherUsername = message.sender_id === currentUserId
    ? message.receiver_username
    : message.sender_username;
  const existing = prevEntries.find((entry) => entry.user_id === otherUserId);
  const unreadCount = countAsUnread
    ? (existing?.unread_count || 0) + 1
    : (existing?.unread_count || 0);
  const nextEntries = prevEntries.filter((entry) => entry.user_id !== otherUserId);

  return [
    {
      user_id: otherUserId,
      username: otherUsername,
      last_message: message.message,
      last_message_at: message.created_at,
      last_sender_id: message.sender_id,
      last_sender_username: message.sender_username,
      unread_count: unreadCount
    },
    ...nextEntries
  ];
}

export function markConversationPreviewEntriesRead(prevEntries, userId) {
  return prevEntries.map((entry) => (
    entry.user_id === userId
      ? { ...entry, unread_count: 0 }
      : entry
  ));
}

export function getSharedResumeTime({
  audioCurrentTime,
  requestedTime,
  fallbackCurrentTime = 0,
  allowAudioOverride = true
}) {
  if (
    allowAudioOverride
    && typeof audioCurrentTime === 'number'
    && Number.isFinite(audioCurrentTime)
    && audioCurrentTime > 0
  ) {
    return audioCurrentTime;
  }

  if (typeof requestedTime === 'number' && Number.isFinite(requestedTime) && requestedTime >= 0) {
    return requestedTime;
  }

  return Math.max(0, Number(fallbackCurrentTime) || 0);
}

export function buildSharedPlayerUpdate({
  currentTrackId,
  audioCurrentTime,
  audioVolume,
  isAudioPaused,
  fallbackCurrentTime = 0,
  fallbackVolume = 1
}) {
  if (!currentTrackId) {
    return null;
  }

  const currentTime = typeof audioCurrentTime === 'number' && Number.isFinite(audioCurrentTime)
    ? audioCurrentTime
    : Math.max(0, Number(fallbackCurrentTime) || 0);
  const volume = typeof audioVolume === 'number' && Number.isFinite(audioVolume)
    ? audioVolume
    : (typeof fallbackVolume === 'number' && Number.isFinite(fallbackVolume) ? fallbackVolume : 1);

  return {
    current_track_id: currentTrackId,
    is_playing: isAudioPaused !== true,
    current_time: currentTime,
    volume
  };
}
