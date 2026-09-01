package com.xiaode.importhelper

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface XiaoDeDao {
    @Query("SELECT * FROM accounts WHERE isCurrent = 1 ORDER BY updatedAt DESC LIMIT 1")
    suspend fun currentAccount(): AccountEntity?

    @Query("SELECT * FROM accounts WHERE accountId = :accountId LIMIT 1")
    suspend fun account(accountId: String): AccountEntity?

    @Query("SELECT * FROM accounts WHERE tokenHash = :tokenHash AND tokenHash != '' LIMIT 1")
    suspend fun accountByTokenHash(tokenHash: String): AccountEntity?

    @Query("SELECT * FROM accounts WHERE username = :username LIMIT 1")
    suspend fun accountByUsername(username: String): AccountEntity?

    @Query("SELECT * FROM accounts ORDER BY updatedAt DESC")
    suspend fun accounts(): List<AccountEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAccount(value: AccountEntity)

    @Query("UPDATE accounts SET isCurrent = 0")
    suspend fun clearCurrentAccount()

    @Query("UPDATE accounts SET isCurrent = CASE WHEN accountId = :accountId THEN 1 ELSE 0 END")
    suspend fun setCurrentAccount(accountId: String)

    @Query("DELETE FROM accounts WHERE accountId = :accountId")
    suspend fun deleteAccount(accountId: String)

    @Query("SELECT * FROM terms WHERE accountId = :accountId ORDER BY termKey DESC")
    suspend fun terms(accountId: String): List<TermEntity>

    @Query("SELECT * FROM terms WHERE accountId = :accountId AND termKey = :termKey LIMIT 1")
    suspend fun term(accountId: String, termKey: String): TermEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTerm(value: TermEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTerms(values: List<TermEntity>)

    @Query("DELETE FROM terms WHERE accountId = :accountId")
    suspend fun deleteTerms(accountId: String)

    @Query("UPDATE terms SET active = CASE WHEN termKey = :termKey THEN 1 ELSE 0 END WHERE accountId = :accountId")
    suspend fun setActiveTerm(accountId: String, termKey: String)

    @Query("SELECT * FROM courses WHERE accountId = :accountId AND termKey = :termKey AND isDeleted = 0 ORDER BY day, startSlot, name")
    suspend fun courses(accountId: String, termKey: String): List<CourseEntity>

    @Query("SELECT * FROM courses WHERE accountId = :accountId")
    suspend fun allCourses(accountId: String): List<CourseEntity>

    @Query("SELECT * FROM courses WHERE localId = :localId LIMIT 1")
    suspend fun course(localId: String): CourseEntity?

    @Query("SELECT * FROM courses WHERE accountId = :accountId AND serverId = :serverId LIMIT 1")
    suspend fun courseByServerId(accountId: String, serverId: String): CourseEntity?

    @Query("SELECT * FROM courses WHERE accountId = :accountId AND clientLocalId = :clientLocalId LIMIT 1")
    suspend fun courseByClientLocalId(accountId: String, clientLocalId: String): CourseEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCourse(value: CourseEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCourses(values: List<CourseEntity>)

    @Query("UPDATE courses SET isDeleted = 1, syncState = 'PENDING', updatedAt = :updatedAt WHERE localId = :localId")
    suspend fun markCourseDeleted(localId: String, updatedAt: String)

    @Query("DELETE FROM courses WHERE localId = :localId")
    suspend fun deleteCourse(localId: String)

    @Query("DELETE FROM courses WHERE accountId = :accountId")
    suspend fun deleteCourses(accountId: String)

    @Query("DELETE FROM courses WHERE accountId = :accountId AND termKey = :termKey")
    suspend fun deleteCoursesForTerm(accountId: String, termKey: String)

    @Query("SELECT * FROM slot_templates WHERE (accountId = :accountId OR accountId = '') ORDER BY accountId DESC, templateId")
    suspend fun templates(accountId: String): List<SlotTemplateEntity>

    @Query("SELECT * FROM slot_templates WHERE (accountId = :accountId OR accountId = '') AND templateId = :templateId ORDER BY accountId DESC LIMIT 1")
    suspend fun template(accountId: String, templateId: String): SlotTemplateEntity?

    @Query("SELECT * FROM slot_templates WHERE templateRowId = :templateRowId LIMIT 1")
    suspend fun templateByRowId(templateRowId: String): SlotTemplateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTemplate(value: SlotTemplateEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTemplates(values: List<SlotTemplateEntity>)

    @Query("DELETE FROM slot_templates WHERE accountId = :accountId")
    suspend fun deleteAccountTemplates(accountId: String)

    @Query("SELECT * FROM preferences WHERE accountId = :accountId LIMIT 1")
    suspend fun preference(accountId: String): PreferenceEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPreference(value: PreferenceEntity)

    @Query("DELETE FROM preferences WHERE accountId = :accountId")
    suspend fun deletePreference(accountId: String)

    @Query("SELECT * FROM sync_metadata WHERE accountId = :accountId LIMIT 1")
    suspend fun syncMetadata(accountId: String): SyncMetadataEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSyncMetadata(value: SyncMetadataEntity)

    @Query("DELETE FROM sync_metadata WHERE accountId = :accountId")
    suspend fun deleteSyncMetadata(accountId: String)

    @Query("SELECT * FROM pending_mutations WHERE accountId = :accountId AND state = 'PENDING' ORDER BY createdAt, operationId")
    suspend fun pendingMutations(accountId: String): List<PendingMutationEntity>

    @Query("SELECT COUNT(*) FROM pending_mutations WHERE accountId = :accountId AND state = 'PENDING'")
    suspend fun pendingCount(accountId: String): Int

    @Query("SELECT COUNT(*) FROM pending_mutations WHERE accountId = :accountId AND entityLocalId = :entityLocalId AND state = 'PENDING'")
    suspend fun pendingForEntity(accountId: String, entityLocalId: String): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertPendingMutation(value: PendingMutationEntity)

    @Query("UPDATE pending_mutations SET attemptCount = attemptCount + 1, lastError = :error WHERE operationId = :operationId")
    suspend fun recordMutationAttempt(operationId: String, error: String)

    @Query("UPDATE pending_mutations SET state = 'CONFLICT', lastError = :error WHERE operationId = :operationId")
    suspend fun markMutationConflict(operationId: String, error: String)

    @Query("DELETE FROM pending_mutations WHERE operationId = :operationId")
    suspend fun deletePendingMutation(operationId: String)

    @Query("""
        UPDATE pending_mutations
        SET serverId = CASE WHEN :serverId != '' THEN :serverId ELSE serverId END,
            baseRevision = :baseRevision
        WHERE accountId = :accountId
          AND entityType = :entityType
          AND entityLocalId = :entityLocalId
          AND state = 'PENDING'
          AND operationId != :completedOperationId
    """)
    suspend fun rebasePendingMutations(
        accountId: String,
        entityType: String,
        entityLocalId: String,
        completedOperationId: String,
        serverId: String,
        baseRevision: Long
    )

    @Query("DELETE FROM pending_mutations WHERE accountId = :accountId")
    suspend fun deletePendingMutations(accountId: String)

    @Query("SELECT * FROM pending_mutations WHERE accountId = :accountId")
    suspend fun allMutations(accountId: String): List<PendingMutationEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertConflict(value: SyncConflictEntity)

    @Query("SELECT * FROM sync_conflicts WHERE accountId = :accountId AND resolvedAt = 0 ORDER BY createdAt DESC")
    suspend fun unresolvedConflicts(accountId: String): List<SyncConflictEntity>

    @Query("DELETE FROM sync_conflicts WHERE accountId = :accountId")
    suspend fun deleteConflicts(accountId: String)
}
