# Access conditions

Choose objects available to an employee: **All**, their own projects or resources, contents of **their projects** or **their processes**. The named owner is checked; nested records may belong to others.

Selected conditions use OR. All replaces the other conditions. No access removes a separate grant.

Viewing always inherits: an accessible project opens all its contents, a process opens its contents, and a task opens subtasks and assignments. A child denial does not cancel parent access. The denial is labelled Through parent only when inheritance applies; child View controls are disabled for a fully open parent.

**Through parent only means No access with an exception:** it removes a separate viewing grant, but an object remains visible inside an accessible parent project, process or task. For example, a task is visible when its containing process or project is accessible; if neither is accessible, this setting does not grant access to the task. Parent means the containing object, not the employee’s manager. Parent-derived viewing always applies: this button neither enables nor disables inheritance. To restrict that viewing, change the parent permissions. Creation, editing and deletion are configured separately.

Creation, editing and deletion do not inherit. Changing project priorities is a separate permission. Assigning a resource always requires matching resource and process owners.

Peer and other complex conditions are no longer offered in this interface version. Previously saved special rules are shown separately and stay effective until explicitly replaced.
