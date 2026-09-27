package com.acme.app.data

import kotlinx.coroutines.flow.Flow

interface FeedRepository {
    /** Emits the cached feed immediately, then again whenever it changes. */
    fun feed(): Flow<List<Post>>

    /** Fetches the newest posts from the server into the cache. */
    suspend fun refresh()

    suspend fun setLiked(postId: String, liked: Boolean)
}
