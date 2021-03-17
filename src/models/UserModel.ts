/*
 * Copyright (c) 2021, IBM Deutschland GmbH
 */
import { Pool } from 'pg';

import { Logger } from '@overnightjs/logger';

import { UserEntry } from '../types/UserEntry';
import { COMPASSConfig } from '../config/COMPASSConfig';
import DB from '../server/DB';
import { IdHelper } from '../services/IdHelper';

export class UserModel {
    private async updateTime(
        user_update_data: UserEntry,
        next_interval: number,
        next_duration: number,
        next_start_hour: number,
        next_due_hour: number,
        start_immediately: boolean,
        additional_iterations_left: number
    ) {
        const now = new Date();
        const interval_start = new Date(now);

        interval_start.setDate(
            interval_start.getDate() + COMPASSConfig.getDefaultIntervalStartIndex()
        );

        const calcTime = (_start_date: Date, startImmediately?: boolean) => {
            // short circuit for testing
            if (COMPASSConfig.isFakeDatesUsed()) {
                const fakeStart = new Date();
                fakeStart.setSeconds(fakeStart.getSeconds() + 10);

                const fakeDue = new Date(fakeStart);
                fakeDue.setSeconds(fakeDue.getSeconds() + 30 * 60);
                return {
                    start_date: fakeStart,
                    due_date: fakeDue,
                    additional_iterations_left: additional_iterations_left
                        ? additional_iterations_left - 1
                        : 0
                };
            }

            let _new_start_date = new Date(_start_date);

            if (user_update_data.start_date) {
                _new_start_date = startImmediately
                    ? new Date(interval_start)
                    : new Date(_new_start_date.setDate(_new_start_date.getDate() + next_interval));
            }
            _new_start_date = new Date(_new_start_date);
            _new_start_date.setHours(next_start_hour, 0, 0, 0);

            let _new_due_date = new Date(_new_start_date);
            _new_due_date.setDate(_new_due_date.getDate() + next_duration);
            _new_due_date.setHours(next_due_hour, 0, 0, 0);
            _new_due_date = new Date(_new_due_date);

            return {
                due_date: _new_due_date,
                start_date: _new_start_date,
                additional_iterations_left: additional_iterations_left
                    ? additional_iterations_left - 1
                    : 0
            };
        };

        let dates = calcTime(
            user_update_data.start_date ? new Date(user_update_data.start_date) : interval_start,
            start_immediately
        );

        while (dates.due_date < now) dates = calcTime(dates.start_date);

        return dates;
    }

    private async updateDistributionValues(user_update_data: UserEntry, parameters: string) {
        const _parameters = JSON.parse(parameters);

        const short_interval = COMPASSConfig.getDefaultShortInterval();
        const short_duration = COMPASSConfig.getDefaultShortDuration();
        const interval = COMPASSConfig.getDefaultInterval();
        const duration = COMPASSConfig.getDefaultDuration();
        const short_start_hour = COMPASSConfig.getDefaultShortStartHour();
        const start_hour = COMPASSConfig.getDefaultStartHour();
        const short_due_hour = COMPASSConfig.getDefaultShortDueHour();
        const due_hour = COMPASSConfig.getDefaultDueHour();
        const short_questionnaire_id = COMPASSConfig.getDefaultShortQuestionnaireId();
        const initial_questionnaire_id = COMPASSConfig.getInitialQuestionnaireId();
        const default_questionnaire_id = COMPASSConfig.getDefaultQuestionnaireId();
        const short_limited_questionnaire_id = COMPASSConfig.getDefaultShortLimitedQuestionnaireId();
        const iteration_count = COMPASSConfig.getDefaultIterationCount();

        if (
            user_update_data.additional_iterations_left > 0 &&
            user_update_data.current_questionnaire_id === short_limited_questionnaire_id
        ) {
            const next_duration =
                user_update_data.current_interval === short_interval ? short_duration : duration;

            const shortmode = user_update_data.current_interval === interval;

            const next_start_hour = shortmode ? short_start_hour : start_hour;

            const next_due_hour = shortmode ? short_due_hour : due_hour;

            const start_immediately = false;

            const additional_iterations_left = user_update_data.additional_iterations_left;

            return [
                user_update_data.current_interval,
                next_duration,
                user_update_data.current_questionnaire_id,
                next_start_hour,
                next_due_hour,
                start_immediately,
                additional_iterations_left
            ];
        } else {
            const switch_to_short_interval = _parameters.basicTrigger || _parameters.specialTrigger;

            const next_interval = switch_to_short_interval ? short_interval : interval;

            const next_duration = switch_to_short_interval ? short_duration : duration;

            const next_questionnaire_id = _parameters.specialTrigger
                ? short_limited_questionnaire_id
                : switch_to_short_interval
                ? short_questionnaire_id
                : !user_update_data.due_date
                ? initial_questionnaire_id
                : default_questionnaire_id;

            const next_start_hour = switch_to_short_interval ? short_start_hour : start_hour;

            const next_due_hour = switch_to_short_interval ? short_due_hour : due_hour;

            const start_immediately = switch_to_short_interval;

            const additional_iterations_left = _parameters.specialTrigger ? iteration_count : 1;

            return [
                next_interval,
                next_duration,
                next_questionnaire_id,
                next_start_hour,
                next_due_hour,
                start_immediately,
                additional_iterations_left
            ];
        }
    }

    /**
     * Update the users current questionnaire, the start and due date and short interval usage.
     *
     * @param studyId The user id
     * @param parameters Parameters as json
     */
    public async updateUser(studyId: string, parameters = '{}'): Promise<UserEntry> {
        const pool: Pool = DB.getPool();

        try {
            const query_result = await pool.query('SELECT * FROM studyuser WHERE study_id = $1', [
                studyId
            ]);

            if (query_result.rows.length !== 1) throw new Error('study_id_not_found');

            let user_update_data = query_result.rows[0] as UserEntry;

            const [
                next_interval,
                next_duration,
                current_questionnaire_id,
                next_start_hour,
                next_due_hour,
                start_immediately,
                additional_iterations_left
            ] = await this.updateDistributionValues(user_update_data, parameters);

            user_update_data = {
                ...user_update_data,
                current_instance_id: IdHelper.createID(),
                current_questionnaire_id,
                ...(await this.updateTime(
                    user_update_data,
                    next_interval,
                    next_duration,
                    next_start_hour,
                    next_due_hour,
                    start_immediately,
                    additional_iterations_left
                )),
                current_interval: next_interval
            } as UserEntry;

            await pool.query(
                'UPDATE studyuser SET current_questionnaire_id = $1, start_date = $2, due_date = $3, current_instance_id = $4, current_interval = $5, additional_iterations_left = $6 WHERE study_id = $7;',
                [
                    user_update_data.current_questionnaire_id,
                    new Date(user_update_data.start_date),
                    new Date(user_update_data.due_date),
                    user_update_data.current_instance_id,
                    next_interval,
                    user_update_data.additional_iterations_left,
                    user_update_data.study_id
                ]
            );

            return {
                current_instance_id: user_update_data.current_instance_id,
                current_questionnaire_id: user_update_data.current_questionnaire_id,
                due_date: new Date(user_update_data.due_date),
                start_date: new Date(user_update_data.start_date),
                study_id: user_update_data.study_id
            } as UserEntry;
        } catch (err) {
            Logger.Err(err);
            throw err;
        }
    }

    /**
     * Retreieve the user from the database and eventually update the users data in case due_date ist outdated or start_date is not set.
     *
     * @param studyID The user id
     */
    public async getAndEventuallyUpdateUserByStudyID(studyID: string): Promise<UserEntry> {
        const pool: Pool = DB.getPool();

        try {
            const res = await pool.query('SELECT * FROM studyuser WHERE study_id = $1', [studyID]);

            if (res.rows.length !== 1) {
                throw new Error('study_id_not_found');
            }

            let result = res.rows[0];
            if (!result.start_date || (result.due_date && result.due_date < new Date())) {
                result = await this.updateUser(result.study_id);
            }
            return result;
        } catch (err) {
            Logger.Err(err);
            throw err;
        }
    }

    /**
     * Update the last action field of the user
     * @param studyID The user id
     */
    public async updateLastAction(studyID: string): Promise<void> {
        try {
            const pool: Pool = DB.getPool();
            await pool.query('UPDATE studyuser SET last_action = $1 WHERE study_id = $2;', [
                new Date(),
                studyID
            ]);
            return;
        } catch (err) {
            Logger.Err(err);
            throw err;
        }
    }

    /**
     * Check if the user exists in the database.
     * @param studyID The user id
     */
    public async checkLogin(studyID: string): Promise<boolean> {
        try {
            const pool: Pool = DB.getPool();
            const res = await pool.query('SELECT study_id FROM studyuser WHERE study_id = $1', [
                studyID
            ]);
            if (res.rows.length !== 1) {
                return false;
            } else {
                return true;
            }
        } catch (err) {
            Logger.Err(err);
            throw err;
        }
    }

    /**
     * Retrieve all study ids / user ids for which a questionnair is available for download.
     *
     * @param referenceDate The reference date used to determine matching user ids
     */
    public async getUsersWithAvailableQuestionnairs(referenceDate: Date): Promise<string[]> {
        // conditions - Start_Date and Due_Date in study_user is set && Due_Date is not reached && no entry in History table present
        try {
            const pool: Pool = DB.getPool();
            const dateParam = this.convertDateToQueryString(referenceDate);
            const res = await pool.query(
                `SELECT
                    S.STUDY_ID
                FROM
                    STUDYUSER S
                LEFT JOIN QUESTIONNAIREHISTORY Q ON
                    S.STUDY_ID = Q.STUDY_ID
                    AND S.CURRENT_QUESTIONNAIRE_ID = Q.QUESTIONNAIRE_ID
                    AND S.CURRENT_INSTANCE_ID = Q.INSTANCE_ID
                WHERE
                    Q.ID IS NULL
                    AND S.START_DATE <= $1
                    AND S.DUE_DATE >= $1;
                `,
                [dateParam]
            );
            return res.rows.map((user) => user.study_id);
        } catch (err) {
            Logger.Err(err);
            throw err;
        }
    }

    /**
     * Retrieve all study ids / user ids for which a questionnair is available for download.
     *
     * @param referenceDate The reference date used to determine matching user ids
     */
    public async getUsersWithPendingUploads(referenceDate: Date): Promise<string[]> {
        // conditions - Start_Date and Due_Date in study_user is set && Due_Date is not reached && one entry in History table with date_sent == null is present
        try {
            const pool: Pool = DB.getPool();
            const dateParam = this.convertDateToQueryString(referenceDate);
            const res = await pool.query(
                `SELECT
                    S.STUDY_ID
                FROM
                    STUDYUSER S,
                    QUESTIONNAIREHISTORY Q
                WHERE
                    S.START_DATE <= $1
                    AND S.DUE_DATE >= $1
                    AND Q.STUDY_ID = S.STUDY_ID
                    AND Q.QUESTIONNAIRE_ID = S.CURRENT_QUESTIONNAIRE_ID
                    AND Q.INSTANCE_ID = S.CURRENT_INSTANCE_ID
                    AND Q.DATE_SENT IS NULL;
                `,
                [dateParam]
            );
            return res.rows.map((user) => user.study_id);
        } catch (err) {
            Logger.Err(err);
            throw err;
        }
    }

    /**
     * Converts a Javascript Date to Postgres-acceptable format.
     *
     * @param date The Date object
     */
    private convertDateToQueryString(date: Date): string {
        const convertedDate = date.toISOString().replace('T', ' ').replace('Z', '');
        Logger.Imp('Converted [' + date + '] to [' + convertedDate + ']');
        return convertedDate;
    }
}
