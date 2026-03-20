FROM alpine:3.19
RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh testuser \
 && echo "testuser:testpass" | chpasswd \
 && sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config \
 && sed -i 's/^#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
 && mkdir -p /home/testuser/.ssh /home/testuser/upload \
 && chown testuser:testuser /home/testuser/.ssh /home/testuser/upload \
 && chmod 700 /home/testuser/.ssh
COPY test_rsa.pub /home/testuser/.ssh/authorized_keys
RUN chown testuser:testuser /home/testuser/.ssh/authorized_keys \
 && chmod 600 /home/testuser/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
