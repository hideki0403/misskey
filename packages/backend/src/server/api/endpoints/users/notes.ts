/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiNote, NotesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { DI } from '@/di-symbols.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { QueryService } from '@/core/QueryService.js';
import { FunoutTimelineService } from '@/core/FunoutTimelineService.js';
import { MiLocalUser } from '@/models/User.js';
import { MetaService } from '@/core/MetaService.js';

export const meta = {
	tags: ['users', 'notes'],

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: '27e494ba-2ac2-48e8-893b-10d4d8c2387b',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userId: { type: 'string', format: 'misskey:id' },
		withReplies: { type: 'boolean', default: false },
		withRenotes: { type: 'boolean', default: true },
		withChannelNotes: { type: 'boolean', default: false },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		withFiles: { type: 'boolean', default: false },
		excludeNsfw: { type: 'boolean', default: false },
	},
	required: ['userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private noteEntityService: NoteEntityService,
		private queryService: QueryService,
		private cacheService: CacheService,
		private idService: IdService,
		private funoutTimelineService: FunoutTimelineService,
		private metaService: MetaService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate!) : null);
			const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate!) : null);
			const isRangeSpecified = untilId != null && sinceId != null;
			const isSelf = me && (me.id === ps.userId);
			const isFollowing = me && Object.hasOwn(await this.cacheService.userFollowingsCache.fetch(me.id), ps.userId);

			const serverSettings = await this.metaService.fetch();

			if (!serverSettings.enableFanoutTimeline || (!isRangeSpecified && sinceId != null)) {
				return await this.getFromDb({
					untilId,
					sinceId,
					userId: ps.userId,
					withReplies: ps.withReplies,
					withRenotes: ps.withRenotes,
					withChannelNotes: ps.withChannelNotes,
					limit: ps.limit,
					withFiles: ps.withFiles,
					excludeNsfw: ps.excludeNsfw,
				}, me, isSelf);
			}

			const [
				userIdsWhoMeMuting,
			] = me ? await Promise.all([
				this.cacheService.userMutingsCache.fetch(me.id),
			]) : [new Set<string>()];

			const timelines = [ps.withFiles ? `userTimelineWithFiles:${ps.userId}` : `userTimeline:${ps.userId}`];
			if (ps.withReplies) timelines.push(`userTimelineWithReplies:${ps.userId}`);
			if (ps.withChannelNotes) timelines.push(`userTimelineWithChannel:${ps.userId}`);

			let redisNotes = await this.funoutTimelineService.getMulti(timelines, sinceId, untilId);

			redisNotes = redisNotes.filter(note => {
				if (me && isUserRelated(note, userIdsWhoMeMuting, true)) return false;

				if (note.renoteUserId) {
					if (note.isNotQuote) {
						if (ps.withRenotes === false) return false;
					}
				}

				if (note.isSensitive && !isSelf) return false;
				if (note.visibility === 'specified' && (!me || (me.id !== note.userId && !note.visibleUserIds.some(v => v === me.id)))) return false;
				if (note.visibility === 'followers' && !isFollowing && !isSelf) return false;

				return true;
			});

			redisNotes.sort((a, b) => a.id > b.id ? -1 : 1);
			redisNotes = redisNotes.slice(0, ps.limit * 2);

			let redisTimeline: MiNote[] = [];

			if (redisNotes.length > 0) {
				const query = this.notesRepository.createQueryBuilder('note')
					.where('note.id IN (:...noteIds)', { noteIds: redisNotes.map(x => x.id) })
					.innerJoinAndSelect('note.user', 'user')
					.leftJoinAndSelect('note.reply', 'reply')
					.leftJoinAndSelect('note.renote', 'renote')
					.leftJoinAndSelect('reply.user', 'replyUser')
					.leftJoinAndSelect('renote.user', 'renoteUser')
					.leftJoinAndSelect('note.channel', 'channel');

				redisTimeline = await query.limit(ps.limit).getMany();
				redisTimeline.sort((a, b) => a.id > b.id ? -1 : 1);
			}

			if (redisTimeline.length === 0) {
				if (!serverSettings.enableFanoutTimelineDbFallback) return [];

				// fallback to db
				return await this.getFromDb({
					untilId,
					sinceId,
					userId: ps.userId,
					withReplies: ps.withReplies,
					withRenotes: ps.withRenotes,
					withChannelNotes: ps.withChannelNotes,
					limit: ps.limit,
					withFiles: ps.withFiles,
					excludeNsfw: ps.excludeNsfw,
				}, me, isSelf);
			}

			return await this.noteEntityService.packMany(redisTimeline, me);
		});
	}

	private async getFromDb(ps: { untilId: string | null, sinceId: string | null, userId: string, limit: number, withReplies: boolean, withRenotes: boolean, withChannelNotes: boolean, withFiles: boolean, excludeNsfw: boolean }, me: MiLocalUser | null, isSelf: boolean | null) {
		//#region Construct query
		const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'), ps.sinceId, ps.untilId)
			.andWhere('note.userId = :userId', { userId: ps.userId })
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('note.channel', 'channel')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		if (ps.withChannelNotes) {
			if (!isSelf) query.andWhere(new Brackets(qb => {
				qb.orWhere('note.channelId IS NULL');
				qb.orWhere('channel.isSensitive = false');
			}));
		} else {
			query.andWhere('note.channelId IS NULL');
		}

		if (!ps.withReplies) {
			query.andWhere(new Brackets(qb => {
				qb
					.where('note.replyId IS NULL') // 返信ではない
					.orWhere(new Brackets(qb => {
						qb // 返信だけど投稿者自身への返信
							.where('note.replyId IS NOT NULL')
							.andWhere('note.replyUserId = note.userId');
					}));
			}));
		}

		this.queryService.generateVisibilityQuery(query, me);
		if (me) {
			this.queryService.generateMutedUserQuery(query, me, { id: ps.userId });
			this.queryService.generateBlockedUserQuery(query, me);
		}

		if (ps.withFiles) {
			query.andWhere('note.fileIds != \'{}\'');
		}

		if (ps.withRenotes === false) {
			query.andWhere(new Brackets(qb => {
				qb.orWhere('note.userId != :userId', { userId: ps.userId });
				qb.orWhere('note.renoteId IS NULL');
				qb.orWhere('note.text IS NOT NULL');
				qb.orWhere('note.fileIds != \'{}\'');
				qb.orWhere('0 < (SELECT COUNT(*) FROM poll WHERE poll."noteId" = note.id)');
			}));
		}
		//#endregion

		const timeline = await query.limit(ps.limit).getMany();

		return await this.noteEntityService.packMany(timeline, me);
	}
}
