package com.acme.app.data

interface AccountApi {
    suspend fun accounts(): List<Account>

    /** Changes for one account since the given cursor (null = from the beginning). */
    suspend fun changesSince(accountId: String, cursor: String?): ChangePage
}

data class ChangePage(val items: List<String>, val nextCursor: String?)
