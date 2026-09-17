(in-package #:quasar.fbp)

(defun safe-unit-id (id)
  (let ((value (canonical-name id)))
    (unless (and (plusp (length value))
                 (every (lambda (character)
                          (or (alphanumericp character) (find character "-_.")))
                        value))
      (error 'validation-error :code "fbp.invalid-deployment-id"
             :message "Deployment ids may contain only letters, digits, dash, dot, and underscore."))
    value))

(defun xdg-path (environment-name fallback &rest parts)
  (let ((root (or (uiop:getenv environment-name)
                  (merge-pathnames fallback (user-homedir-pathname)))))
    (reduce #'merge-pathnames parts :initial-value (uiop:ensure-directory-pathname root))))

(defun automation-plan (network &key executable graph-path)
  "Return a write/enable plan. It never includes secret values."
  (let* ((id (safe-unit-id (network-id network)))
         (unit-name (format nil "quasar-fbp@~A.service" id))
         (unit-path (merge-pathnames unit-name
                                     (xdg-path "XDG_CONFIG_HOME" ".config/"
                                               "systemd/" "user/")))
         (source (or graph-path
                     (merge-pathnames (format nil "workflows/~A.lisp" id)
                                      (xdg-path "XDG_CONFIG_HOME" ".config/" "quasar/"))))
         (runner (or executable "/usr/bin/env quasar-fbp"))
         (unit (format nil
                       "[Unit]~%Description=Quasar FBP automation %i~%After=network-online.target~%~%[Service]~%Type=simple~%ExecStart=~A run --graph ~A~%NoNewPrivileges=yes~%PrivateTmp=yes~%ProtectSystem=strict~%ProtectHome=read-only~%RestrictSUIDSGID=yes~%LockPersonality=yes~%MemoryDenyWriteExecute=yes~%~%[Install]~%WantedBy=default.target~%"
                       runner (namestring source))))
    (list :id id :unit-name unit-name :unit-path unit-path
          :graph-path source :graph-source (network-to-lisp network)
          :unit-source unit
          :enable (and (network-enabled-at-login-p network) t)
          :commands (append (list (list "systemctl" "--user" "daemon-reload"))
                            (when (network-enabled-at-login-p network)
                              (list (list "systemctl" "--user" "enable" "--now" unit-name)))))))

(defun atomic-write-text (path content)
  (ensure-directories-exist path)
  (let ((temporary (make-pathname :name (format nil ".~A.tmp" (pathname-name path))
                                  :type (pathname-type path)
                                  :defaults path)))
    (with-open-file (stream temporary :direction :output :if-exists :supersede
                                      :if-does-not-exist :create)
      (write-string content stream)
      (finish-output stream))
    (rename-file temporary path)))

(defun apply-automation-plan (plan &key (execute-commands nil))
  (atomic-write-text (getf plan :graph-path) (getf plan :graph-source))
  (atomic-write-text (getf plan :unit-path) (getf plan :unit-source))
  (when execute-commands
    (dolist (argv (getf plan :commands))
      (uiop:run-program argv :output *standard-output* :error-output *error-output*)))
  plan)

(defun profile-plan (&key endpoint (credential-reference "credential:starintel-api")
                          (shell :sh))
  "Create an idempotent managed profile block containing references, never keys."
  (unless (member shell '(:sh :bash))
    (error 'validation-error :code "fbp.unsupported-shell"
           :message "Only POSIX sh and bash profiles are supported."))
  (let* ((profile (merge-pathnames (if (eq shell :bash) ".bash_profile" ".profile")
                                   (user-homedir-pathname)))
         (begin "# >>> quasar-fbp >>>")
         (end "# <<< quasar-fbp <<<")
         (block (format nil "~A~%export STARINTEL_ENDPOINT=~S~%export STARINTEL_CREDENTIAL_REF=~S~%~A~%"
                        begin (or endpoint "http://127.0.0.1:5000")
                        credential-reference end)))
    (list :path profile :begin begin :end end :content block)))

(defun strip-managed-block (source begin end)
  (let ((start (search begin source))
        (finish nil))
    (if (null start)
        source
        (progn
          (setf finish (search end source :start2 (+ start (length begin))))
          (if finish
              (concatenate 'string (subseq source 0 start)
                           (subseq source (+ finish (length end))))
              (subseq source 0 start))))))

(defun apply-profile-plan (plan)
  (let* ((path (getf plan :path))
         (existing (if (probe-file path) (uiop:read-file-string path) ""))
         (base (string-right-trim '(#\Space #\Tab #\Newline #\Return)
                                  (strip-managed-block existing
                                                       (getf plan :begin)
                                                       (getf plan :end))))
         (updated (format nil "~A~@[~%~]~A" base (plusp (length base))
                          (getf plan :content))))
    (atomic-write-text path updated)
    plan))
