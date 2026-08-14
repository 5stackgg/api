export enum SystemSettingName {
  Updates = "updates",
  ChatMessageTtl = "chat_message_ttl",
  DemoNetworkLimiter = "demo_network_limiter",
  PublicDefaultModels = "public.default_models",
  VetoPickTimeout = "public.veto_pick_timeout",
  SupportsDiscordBot = "public.supports_discord_bot",
  SupportsGameServerNodes = "supports_game_server_nodes",
  SupportsGameServerVersionPinning = "supports_game_server_version_pinning",
  EventsEnabled = "public.events_enabled",
  NewsEnabled = "public.news_enabled",
  NewsLabel = "public.news_label",
  PostNewsRole = "public.post_news_role",
  CreateAwardsRole = "public.create_awards_role",
  GrantAwardsRole = "public.grant_awards_role",
  RequireLoginForLiveStreams = "public.require_login_for_live_streams",
  CameraRequiredDefault = "public.camera_required_default",
  CameraAllowTeammatesDefault = "public.camera_allow_teammates_default",
  VoiceChatEnabled = "public.voice_chat_enabled",
  // Only the master switch is read here. Which surfaces offer a camera --
  // lobbies, matches -- is decided in the web app, exactly as the voice
  // equivalents are: gating it here would mean asking which sort of channel an
  // id belongs to, and assertMember is deliberately built not to care.
  VideoChatEnabled = "public.video_chat_enabled",
  LeaguesEnabled = "public.leagues_enabled",
  GameServerPluginRuntime = "public.game_server_plugin_runtime",
  GameServerPluginRuntimeLocked = "game_server_plugin_runtime_locked",
  // VAPID identifies this panel to the browser push services. The keypair is
  // self-generated -- there is no vendor to register with -- so it is stored
  // here rather than demanding an env var of every operator. The private half
  // is never exposed to any role; see public_settings.yaml.
  WebPushPublicKey = "web_push_public_key",
  WebPushPrivateKey = "web_push_private_key",
}
