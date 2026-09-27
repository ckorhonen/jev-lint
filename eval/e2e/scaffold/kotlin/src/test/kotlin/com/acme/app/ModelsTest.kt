package com.acme.app

import com.acme.app.data.Post
import kotlin.test.Test
import kotlin.test.assertEquals

class ModelsTest {
    @Test
    fun copyKeepsId() {
        val post = Post("p1", "Ada", "hello", likeCount = 0, likedByMe = false)
        assertEquals("p1", post.copy(likeCount = 1).id)
    }
}
