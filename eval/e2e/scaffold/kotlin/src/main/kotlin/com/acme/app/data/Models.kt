package com.acme.app.data

data class Post(
    val id: String,
    val authorName: String,
    val text: String,
    val likeCount: Int,
    val likedByMe: Boolean,
)

data class Account(val id: String, val displayName: String)
