(in-package #:quasar.control-plane)

(defvar *command-principal* nil
  "Server-authenticated principal for the command currently executing.")

(defvar *command-authority-kind* :internal
  "Server-assigned authority class for the command currently executing.")

(defun delegated-user-command-p ()
  (eq *command-authority-kind* :delegated-user))

(defun current-command-principal ()
  *command-principal*)

(defun normalize-command-authority (principal authority-kind)
  (when (eq authority-kind :delegated-user)
    (quasar.protocol:ensure-string
     principal "principal" "security.unauthorized"))
  (values principal authority-kind))

(defun submit-command
    (plane encoded reply &key principal (authority-kind :internal))
  "Submit a wire command with optional server-authenticated authority context.

PRINCIPAL and AUTHORITY-KIND are transport-side values. They are never decoded
from the client JSON envelope."
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (multiple-value-bind (trusted-principal trusted-kind)
      (normalize-command-authority principal authority-kind)
    (let ((envelope (quasar.protocol:decode-command encoded)))
      (sento.actor:tell
       (control-plane-command-actor plane)
       (list :envelope envelope
             :reply reply
             :principal trusted-principal
             :authority-kind trusted-kind))
      (quasar.protocol:command-envelope-id envelope))))

(defun submit-decoded
    (plane envelope reply &key principal (authority-kind :internal))
  "Submit an already decoded command with server-authenticated authority context."
  (unless (control-plane-started-p plane)
    (error "Quasar control plane is not started."))
  (multiple-value-bind (trusted-principal trusted-kind)
      (normalize-command-authority principal authority-kind)
    (sento.actor:tell
     (control-plane-command-actor plane)
     (list :envelope envelope
           :reply reply
           :principal trusted-principal
           :authority-kind trusted-kind))
    (quasar.protocol:command-envelope-id envelope)))