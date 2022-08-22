// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the GNU Affero General Public License v3.0.
// See the LICENCE file in the repository root for full licence text.

import { DiscussionType, discussionTypeIcons } from 'beatmap-discussions/discussion-type';
import BigButton from 'components/big-button';
import StringWithComponent from 'components/string-with-component';
import TimeWithTooltip from 'components/time-with-tooltip';
import UserAvatar from 'components/user-avatar';
import BeatmapExtendedJson from 'interfaces/beatmap-extended-json';
import BeatmapsetDiscussionJson from 'interfaces/beatmapset-discussion-json';
import { BeatmapsetDiscussionPostStoreResponseJson } from 'interfaces/beatmapset-discussion-post-responses';
import BeatmapsetExtendedJson from 'interfaces/beatmapset-extended-json';
import { BeatmapsetWithDiscussionsJson } from 'interfaces/beatmapset-json';
import CurrentUserJson from 'interfaces/current-user-json';
import GameMode from 'interfaces/game-mode';
import { route } from 'laroute';
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { observer } from 'mobx-react';
import core from 'osu-core-singleton';
import * as React from 'react';
import TextareaAutosize from 'react-autosize-textarea';
import { onError } from 'utils/ajax';
import { canModeratePosts, validMessageLength } from 'utils/beatmapset-discussion-helper';
import { nominationsCount } from 'utils/beatmapset-helper';
import { classWithModifiers } from 'utils/css';
import { InputEventType, makeTextAreaHandler } from 'utils/input-handler';
import { hideLoadingOverlay, showLoadingOverlay } from 'utils/loading-overlay';
import { linkHtml } from 'utils/url';
import MessageLengthCounter from './message-length-counter';

const bn = 'beatmap-discussion-new';

type Discussion = BeatmapsetDiscussionJson & Required<Pick<BeatmapsetDiscussionJson, 'current_user_attributes'>>;
type Mode = 'events' | 'general' | 'generalAll' | 'timeline' | 'reviews';

// TODO: move to store/context
interface CurrentDiscussions {
  byFilter: {
    deleted: DiscussionByFilter;
    hype: DiscussionByFilter;
    mapperNotes: DiscussionByFilter;
    mine: DiscussionByFilter;
    pending: DiscussionByFilter;
    praises: DiscussionByFilter;
    resolved: DiscussionByFilter;
    total: DiscussionByFilter;
  };
  countsByBeatmap: Record<number, number>;
  countsByPlaymode: Record<GameMode, number>;
  general: Discussion[];
  generalAll: Discussion[];
  reviews: Discussion[];
  timeline: Discussion[];
  timelineAllUsers: Discussion[];
  totalHype: number;
  unresolvedIssues: number;
}

interface DiscussionByFilter {
  general: Record<number, Discussion>;
  generalAll: Record<number, Discussion>;
  reviews: Record<number, Discussion>;
  timeline: Record<number, Discussion>;
}

interface DiscussionsCache {
  beatmap: BeatmapExtendedJson;
  discussions: Discussion[];
  timestamp: number | null;
}

interface Props {
  autoFocus: boolean;
  beatmapset: BeatmapsetExtendedJson & BeatmapsetWithDiscussionsJson;
  currentBeatmap: BeatmapExtendedJson;
  currentDiscussions: CurrentDiscussions;
  currentUser: CurrentUserJson;
  innerRef: React.RefObject<HTMLDivElement>;
  mode: Mode;
  pinned: boolean;
  setPinned: (flag: boolean) => void;
  stickTo: React.RefObject<HTMLElement>;
}

@observer
export class NewDiscussion extends React.Component<Props> {
  private readonly disposers = new Set<((() => void) | undefined)>();
  private readonly handleKeyDown;
  private readonly inputBox = React.createRef<HTMLTextAreaElement>();
  @observable private message = this.storedMessage;
  @observable private mounted = false;
  private nearbyDiscussionsCache: DiscussionsCache | null = null;
  @observable private posting: string | null = null;
  private postXhr: JQuery.jqXHR<BeatmapsetDiscussionPostStoreResponseJson> | null = null;
  @observable private timestampConfirmed = false;

  private get canPost() {
    return !this.props.currentUser.is_silenced
      && (!this.props.beatmapset.discussion_locked
        || canModeratePosts(this.props.currentUser))
      && (this.props.currentBeatmap.deleted_at == null || this.props.mode === 'generalAll');
  }

  @computed
  private get cssTop() {
    if (!this.mounted || !this.props.pinned || this.props.stickTo?.current == null) return;
    return core.stickyHeader.headerHeight + this.props.stickTo.current.getBoundingClientRect().height;
  }

  private get isTimeline() {
    return this.props.mode === 'timeline';
  }

  private get nearbyDiscussions() {
    const timestamp = this.timestamp;
    if (timestamp == null) return [];

    if (this.nearbyDiscussionsCache == null || (this.nearbyDiscussionsCache.beatmap !== this.props.currentBeatmap || this.nearbyDiscussionsCache.timestamp !== this.timestamp)) {
      this.nearbyDiscussionsCache = {
        beatmap: this.props.currentBeatmap,
        discussions: BeatmapDiscussionHelper.nearbyDiscussions(this.props.currentDiscussions.timelineAllUsers, timestamp),
        timestamp: this.timestamp,
      };
    }

    return this.nearbyDiscussionsCache?.discussions ?? [];
  }

  private get storageKey() {
    return `beatmapset-discussion:store:${this.props.beatmapset.id}:message`;
  }

  private get storedMessage() {
    return localStorage.getItem(this.storageKey) ?? '';
  }

  @computed
  private get timestamp() {
    return this.props.mode === 'timeline'
      ? BeatmapDiscussionHelper.parseTimestamp(this.message)
      : null;
  }

  private get validPost() {
    if (!validMessageLength(this.message, this.isTimeline)) return false;

    if (this.isTimeline) {
      return this.timestamp != null && (this.nearbyDiscussions.length === 0 || this.timestampConfirmed);
    }

    return true;
  }

  constructor(props: Props) {
    super(props);
    makeObservable(this);
    this.handleKeyDown = makeTextAreaHandler(this.handleKeyDownCallback);
  }

  componentDidMount() {
    this.disposers.add(core.reactTurbolinks.runAfterPageLoad(() => this.mounted = true));
    if (this.props.autoFocus) {
      this.disposers.add(core.reactTurbolinks.runAfterPageLoad(() => this.inputBox.current?.focus()));
    }
  }

  componentDidUpdate(prevProps: Readonly<Props>) {
    if (prevProps.beatmapset.id !== this.props.beatmapset.id) {
      this.message = this.storedMessage;
      return;
    }
    this.storeMessage();
  }

  componentWillUnmount() {
    this.postXhr?.abort();
    this.disposers.forEach((disposer) => disposer?.());
  }

  render() {
    const cssClasses = classWithModifiers('beatmap-discussion-new-float', { pinned: this.props.pinned });

    return (
      <div
        className={cssClasses}
        style={{ top: this.cssTop }}
      >
        <div className='beatmap-discussion-new-float__floatable'>
          <div
            ref={this.props.innerRef}
            className='beatmap-discussion-new-float__content'
          >
            {this.renderBox()}
          </div>
        </div>
      </div>
    );
  }

  private readonly handleKeyDownCallback = (type: InputEventType | null) => {
    // Ignores SUBMIT, requiring shift-enter to add new line.
    if (type === InputEventType.Cancel) {
      this.setSticky(false);
    }
  };

  private messagePlaceholder() {
    if (this.canPost) {
      return osu.trans(`beatmaps.discussions.message_placeholder.${this.props.mode}`, { version: this.props.currentBeatmap.version });
    }

    if (this.props.currentUser.is_silenced) {
      return osu.trans('beatmaps.discussions.message_placeholder_silenced');
    } else if (this.props.beatmapset.discussion_locked) {
      return osu.trans('beatmaps.discussions.message_placeholder_locked');
    } else {
      return osu.trans('beatmaps.discussions.message_placeholder_deleted_beatmap');
    }
  }

  private readonly onFocus = () => this.setSticky(true);

  @action
  private readonly post = (e: React.SyntheticEvent<HTMLElement>) => {
    if (!this.validPost || this.postXhr != null) return;

    const type = e.currentTarget.dataset.type;
    if (type == null) return;

    if (type === 'problem') {
      const problemType = this.problemType();
      if (problemType !== 'problem') {
        if (!confirm(osu.trans(`beatmaps.nominations.reset_confirm.${problemType}`))) return;
      }
    }

    if (type === 'hype') {
      if (!confirm(osu.trans('beatmaps.hype.confirm', { n: this.props.beatmapset.current_user_attributes.remaining_hype }))) return;
    }

    showLoadingOverlay();
    this.posting = type;

    const data = {
      beatmap_discussion: {
        beatmap_id: this.props.mode === 'generalAll' ? undefined : this.props.currentBeatmap.id,
        message_type: type,
        timestamp: this.timestamp,
      },
      beatmap_discussion_post: {
        message: this.message,
      },
      beatmapset_id: this.props.currentBeatmap.beatmapset_id,
    };

    this.postXhr = $.ajax(route('beatmapsets.discussions.posts.store'), {
      data,
      method: 'POST',
    });

    this.postXhr
      .done((json) => runInAction(() => {
        this.message = '';
        this.timestampConfirmed = false;
        $.publish('beatmapDiscussionPost:markRead', { id: json.beatmap_discussion_post_ids });
        $.publish('beatmapsetDiscussions:update', { beatmapset: json.beatmapset });
      }))
      .fail(onError)
      .always(action(() => {
        hideLoadingOverlay();
        this.postXhr = null;
        this.posting = null;
      }));
  };

  private problemType() {
    const canDisqualify = core.currentUser?.is_admin || core.currentUser?.is_moderator || core.currentUser?.is_full_bn;
    const willDisqualify = this.props.beatmapset.status === 'qualified';

    if (canDisqualify && willDisqualify) return 'disqualify';

    const canReset = core.currentUser?.is_admin || core.currentUser?.is_nat || core.currentUser?.is_bng;
    const currentNominations = nominationsCount(this.props.beatmapset.nominations, 'current');
    const willReset = this.props.beatmapset.status === 'pending' && currentNominations > 0;

    if (canReset && willReset) return 'nomination_reset';
    if (willDisqualify) return 'problem_warning';

    return 'problem';
  }

  private renderBox() {
    const canHype = this.props.beatmapset.current_user_attributes?.can_hype
      && this.props.beatmapset.can_be_hyped
      && this.props.mode === 'generalAll';

    const canPostNote =
        this.props.currentUser.id === this.props.beatmapset.user_id
          || (this.props.currentUser.id === this.props.currentBeatmap.user_id && this.props.mode in ['general', 'timeline'])
          || this.props.currentUser.is_bng
          || canModeratePosts(this.props.currentUser);

    const buttonCssClasses = classWithModifiers('btn-circle', { activated: this.props.pinned });

    return (
      <div className='osu-page osu-page--small'>
        <div className={bn}>
          <div className='page-title'>
            {osu.trans('beatmaps.discussions.new.title')}

            <span className='page-title__button'>
              <span
                className={buttonCssClasses}
                onClick={this.toggleSticky}
                title={osu.trans(`beatmaps.discussions.new.${this.props.pinned ? 'unpin' : 'pin'}`)}
              >
                <span className='btn-circle__content'>
                  <i className='fas fa-thumbtack' />
                </span>
              </span>
            </span>
          </div>
          <div className={`${bn}__content`}>
            <div className={`${bn}__avatar`}>
              <UserAvatar modifiers='full-rounded' user={this.props.currentUser} />
            </div>
            <div className={`${bn}__message`} id='new'>
              {this.props.currentUser?.id != null ? (
                <>
                  <TextareaAutosize
                    key='input'
                    ref={this.inputBox}
                    className={`${bn}__message-area js-hype--input`}
                    disabled={this.posting != null || !this.canPost}
                    onChange={this.setMessage}
                    onFocus={this.onFocus}
                    onKeyDown={this.handleKeyDown}
                    placeholder={this.messagePlaceholder()}
                    value={this.canPost ? this.message : ''}
                  />

                  <MessageLengthCounter
                    key='counter'
                    isTimeline={this.isTimeline}
                    message={this.message}
                  />
                </>
              ) : osu.trans('beatmaps.discussions.require-login')}
            </div>
          </div>

          <div className={`${bn}__footer`}>
            {this.renderTimestamp()}
            {this.renderHype()}
            <div className={`${bn}__footer-content ${bn}__footer-content--right`}>
              {canHype && this.submitButton('hype')}
              {canPostNote && this.submitButton('mapper_note')}
              {this.submitButton('praise')}
              {this.submitButton('suggestion')}
              {this.submitButton('problem')}
            </div>
          </div>
          {this.renderNearbyTimestamps()}
        </div>
      </div>
    );
  }

  private renderGuest() {
    if (!(this.props.mode === 'generalAll' && this.props.beatmapset.can_be_hyped)) return null;
    if (this.props.currentUser?.id != null) return null;
    return osu.trans('beatmaps.hype.explanation_guest');
  }

  private renderHype() {
    if (!(this.props.mode === 'generalAll' && this.props.beatmapset.can_be_hyped)) return null;
    if (this.props.currentUser?.id == null) {
      return this.renderGuest();
    }

    return (
      <div className={`${bn}__footer-content js-hype--explanation js-flash-border`}>
        <div className={`${bn}__timestamp-col ${bn}__timestamp-col--label`}>
          {osu.trans('beatmaps.hype.title')}
        </div>
        <div className={`${bn}__timestamp-col`}>
          {this.props.beatmapset.current_user_attributes.can_hype ? osu.trans('beatmaps.hype.explanation') : this.props.beatmapset.current_user_attributes.can_hype_reason}
          {(this.props.beatmapset.current_user_attributes.can_hype || this.props.beatmapset.current_user_attributes.remaining_hype <= 0) && (
            <>
              <StringWithComponent
                mappings={{ remaining: this.props.beatmapset.current_user_attributes.remaining_hype }}
                pattern={` ${osu.trans('beatmaps.hype.remaining')}`}
              />
              {this.props.beatmapset.current_user_attributes.new_hype_time != null && (
                <StringWithComponent
                  mappings={{
                    new_time: <TimeWithTooltip dateTime={this.props.beatmapset.current_user_attributes.new_hype_time} relative />,
                  }}
                  pattern={` ${osu.trans('beatmaps.hype.new_time')}`}
                />
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  private renderNearbyTimestamps() {
    if (this.nearbyDiscussions.length === 0) return;
    const currentTimestamp = BeatmapDiscussionHelper.formatTimestamp(this.timestamp);
    const timestamps = this.nearbyDiscussions.map((discussion) => (
      linkHtml(
        BeatmapDiscussionHelper.url({ discussion }),
        BeatmapDiscussionHelper.formatTimestamp(discussion.timestamp) ?? '',
        { classNames: ['js-beatmap-discussion--jump'] },
      )
    ));

    const timestampsString = osu.transArray(timestamps);

    return (
      <div className={`${bn}__notice`}>
        <div
          className={`${bn}__notice-text`}
          dangerouslySetInnerHTML={{
            __html: osu.trans('beatmap_discussions.nearby_posts.notice', {
              existing_timestamps: timestampsString,
              timestamp: currentTimestamp,
            }),
          }}
        />

        <label className={`${bn}__notice-checkbox`}>
          <div className='osu-switch-v2'>
            <input
              checked={this.timestampConfirmed}
              className='osu-switch-v2__input'
              onChange={this.toggleTimestampConfirmation}
              type='checkbox'
            />
            <span className='osu-switch-v2__content' />
          </div>
          {osu.trans('beatmap_discussions.nearby_posts.confirm')}
        </label>
      </div>
    );
  }

  private renderTimestamp() {
    if (this.props.mode !== 'timeline') return null;

    const timestamp = BeatmapDiscussionHelper.formatTimestamp(this.timestamp) ?? osu.trans('beatmaps.discussions.new.timestamp_missing');

    return (
      <div className={`${bn}__footer-content`}>
        <div className={`${bn}__timestamp-col ${bn}__timestamp-col--label`}>
          {osu.trans('beatmaps.discussions.new.timestamp')}
        </div>
        <div className={`${bn}__timestamp-col`}>
          {timestamp}
        </div>
      </div>
    );
  }

  @action
  private readonly setMessage = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    this.message = e.target.value;
  };

  @action
  private readonly setSticky = (sticky = true) => {
    this.props.setPinned(sticky);
  };

  private storeMessage() {
    if (!osu.present(this.message)) {
      localStorage.removeItem(this.storageKey);
    } else {
      localStorage.setItem(this.storageKey, this.message);
    }
  }

  private submitButton(type: DiscussionType) {
    const typeText = type === 'problem' ? this.problemType() : type;
    const props = {
      'data-type': type,
      onClick: this.post,
    };

    return (
      <BigButton
        key={type}
        disabled={!this.validPost || this.posting != null || !this.canPost}
        icon={discussionTypeIcons[type]}
        isBusy={this.posting === type}
        props={props}
        text={osu.trans(`beatmaps.discussions.message_type.${typeText}`)}
      />
    );
  }

  private readonly toggleSticky = () => {
    this.setSticky(!this.props.pinned);
  };

  @action
  private readonly toggleTimestampConfirmation = () => {
    this.timestampConfirmed = !this.timestampConfirmed;
  };
}
