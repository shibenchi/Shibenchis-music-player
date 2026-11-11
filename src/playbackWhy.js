// why a song would not play, in words a person can act on. the page asks the questions when a song fails (is the internet there, does
// youtube answer, is the video still there, what does the audio helper say) and this puts the answers together. it is kept apart from
// the page so it can be tested alone
//
// kinds: gone (youtube says the video was removed or made private), blocked (youtube has it and refuses to hand its audio to this
// connection: another country, an age check), botcheck (youtube wants this network to prove it is not a robot), network (the connection
// to youtube is down or too weak), helper (the audio helper inside the app does not answer), slow (it loads now, it did not a moment
// ago), unknown (nothing above fits, the raw answer is shown)

const NETWORK_WORDS = /unable to download|timed out|timeout|name or service not known|getaddrinfo|network is unreachable|connection (reset|refused|aborted)|no route to host|temporary failure in name resolution|unknownhost|ssl|eof occurred|remote end closed|incomplete read|no network/i;
const UNAVAILABLE_WORDS = /video unavailable|this video is (not available|unavailable|private|no longer available)|private video|has been removed|removed by the uploader|account (associated with this video )?has been terminated|blocked it in your country|not available in your country|not made this video available|video is not available|confirm your age|age.restrict|unplayable/i;

const trim = (text, max = 110) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 3) + '...' : clean;
};

const minutesText = (seconds) => {
  const s = Math.max(30, Number(seconds) || 180);
  return s < 90 ? 'about a minute' : `about ${Math.round(s / 60)} minutes`;
};

// the lines of what was looked at, shown under the explanation
function checkedLines({ internet, youtube, helper }) {
  const lines = [];
  if (internet === 'down') lines.push('device network: offline');
  else if (internet === 'up') lines.push('device network: connected');
  if (youtube) {
    lines.push(`youtube: ${youtube.reachable ? 'answers' : 'did not answer'}`);
    lines.push(`this video: ${youtube.video === 'there' ? 'still on youtube' : youtube.video === 'gone' ? 'removed or private' : 'could not check'}`);
  }
  if (helper) {
    if (helper.state === 'ok') lines.push('audio helper: gave the audio just now');
    else if (helper.state === 'unreachable') lines.push('audio helper: does not answer');
    else if (helper.state === 'timeout') lines.push('audio helper: no answer in 12 seconds');
    else if (helper.state === 'http') lines.push(`audio helper: ${helper.code === 'youtube_bot_check' ? 'youtube is asking for a robot check' : helper.code === 'unavailable' ? 'says this video is not available' : trim(helper.message || 'error', 70)} (${helper.status})`);
  }
  return lines;
}

// internet: 'down' | 'up' | 'unknown'
// youtube: { reachable: boolean, video: 'there' | 'gone' | 'unknown' } or null when it was not asked
// helper: { state: 'ok' | 'http' | 'unreachable' | 'timeout', status, code, message, retryAfterSec, helperDown } or null
// phone: true in the phone app (the helper is part of the app and takes a moment to start)
// short: the cause in a few words (a toast). text: the same with the one fact that matters, shown after "error:". both say it plainly and
// stop, what to do about it is on the buttons
export function explainFailure({ internet = 'unknown', youtube = null, helper = null, phone = false } = {}) {
  const checked = checkedLines({ internet, youtube, helper });
  const result = (kind, short, text) => ({ kind, short, text: text || short, checked });
  const youtubeAnswers = !youtube || youtube.reachable !== false;
  const weakConnection = () => result('network', 'connection to youtube is down or weak');

  if (internet === 'down') {
    return result('network', 'no internet connection');
  }

  if (helper && helper.state === 'ok') {
    return result('slow', 'connection was too slow, it loads now');
  }

  if (helper && helper.state === 'http' && helper.code === 'youtube_bot_check') {
    return result('botcheck', 'youtube wants a robot check', `youtube wants a robot check on this network, try again in ${minutesText(helper.retryAfterSec)}`);
  }

  if (helper && helper.state === 'unreachable') {
    if (youtube && youtube.reachable === false) return weakConnection();
    return result('helper', 'audio helper is not answering', phone
      ? 'audio helper is not answering, it may still be starting, restart the app if it stays'
      : 'audio helper is not answering, restart the app');
  }

  if (helper && helper.state === 'timeout') {
    if (youtube && youtube.reachable === false) return weakConnection();
    return result('slow', 'youtube is very slow right now', 'youtube did not answer in 12 seconds, try again in a minute');
  }

  if (helper && helper.state === 'http') {
    const message = String(helper.message || '');
    if (helper.code === 'network_down' || (helper.code !== 'unavailable' && NETWORK_WORDS.test(message) && !UNAVAILABLE_WORDS.test(message))) {
      return result('network', 'connection to youtube is down or weak', `could not reach youtube (${trim(message, 90)})`);
    }
    if (helper.code === 'unavailable' || helper.status === 410 || UNAVAILABLE_WORDS.test(message)) {
      if (youtube && youtube.video === 'gone') {
        return result('gone', 'removed or made private on youtube');
      }
      if (!youtubeAnswers) {
        return result('network', 'connection to youtube is down or weak', 'youtube refused it, then stopped answering');
      }
      if (youtube && youtube.video === 'unknown') {
        return result('unknown', 'youtube refused it, cause unclear', `youtube refused it (${trim(message || 'unavailable', 60)}) and the video could not be checked, try another connection`);
      }
      return result('blocked', 'youtube blocks this video here', 'youtube has it but blocks this connection, likely a country block or age limit');
    }
    return result('unknown', 'cause unknown', `cause unknown, the audio helper said "${trim(message || 'nothing', 80)}" (${helper.status})`);
  }

  if (youtube && youtube.reachable === false) {
    return weakConnection();
  }
  if (youtube && youtube.video === 'gone') {
    return result('gone', 'removed or made private on youtube');
  }
  return result('unknown', 'cause unknown', 'cause unknown, none of the checks found one');
}
