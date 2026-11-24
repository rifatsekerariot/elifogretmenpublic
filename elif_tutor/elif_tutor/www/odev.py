import frappe

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect

    context.no_header = True
    context.no_footer = True
    context.user_fullname = frappe.utils.get_fullname(frappe.session.user) or frappe.session.user
    context.csrf_token = frappe.sessions.get_csrf_token()
    return context
