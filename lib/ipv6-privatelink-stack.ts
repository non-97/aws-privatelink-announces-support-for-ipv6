import {
  Fn,
  Stack,
  StackProps,
  aws_iam as iam,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_targets as elbv2Targtes,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";

export class Ipv6PrivatelinkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // IAM Role
    const ssmIamRole = new iam.Role(this, "SSM IAM Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // VPC
    const consumerVPC = new IPv6Vpc(this, "Consumer VPC", {
      cidr: "10.10.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28,
        },
      ],
    });

    const providerVPC = new IPv6Vpc(this, "Provider VPC", {
      cidr: "10.10.0.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
          cidrMask: 28,
        },
      ],
    });

    // User data for Provider EC2 Instance
    const userDataProviderEC2InstanceParameter = fs.readFileSync(
      path.join(__dirname, "../src/ec2/user_data_provider_ec2_instance.sh"),
      "utf8"
    );
    const userDataProviderEC2Instance = ec2.UserData.forLinux({
      shebang: "#!/bin/bash",
    });
    userDataProviderEC2Instance.addCommands(
      userDataProviderEC2InstanceParameter
    );

    // Security Group
    const consumerEC2InstanceSG = new ec2.SecurityGroup(
      this,
      "Consumer EC2 Instance SG",
      {
        vpc: consumerVPC,
        description: "",
        allowAllOutbound: false,
      }
    );
    consumerEC2InstanceSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp());
    consumerEC2InstanceSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allUdp());
    consumerEC2InstanceSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp());
    consumerEC2InstanceSG.addEgressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.allTraffic()
    );

    const providerEC2InstanceSG = new ec2.SecurityGroup(
      this,
      "Provider EC2 Instance SG",
      {
        vpc: providerVPC,
        description: "",
        allowAllOutbound: false,
      }
    );
    providerEC2InstanceSG.addIngressRule(
      ec2.Peer.ipv4(providerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );
    providerEC2InstanceSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp());
    providerEC2InstanceSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allUdp());
    providerEC2InstanceSG.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp());
    providerEC2InstanceSG.addEgressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.allTraffic()
    );

    const vpcEndpointSG = new ec2.SecurityGroup(this, "VPC Endpoint SG", {
      vpc: consumerVPC,
      description: "",
      allowAllOutbound: true,
    });
    vpcEndpointSG.addIngressRule(
      ec2.Peer.ipv4(consumerVPC.vpcCidrBlock),
      ec2.Port.tcp(80)
    );
    consumerVPC.vpcIpv6CidrBlocks.forEach((vpcIpv6CidrBlock, index) => {
      vpcEndpointSG.addIngressRule(
        ec2.Peer.ipv6(Fn.select(index, consumerVPC.vpcIpv6CidrBlocks)),
        ec2.Port.tcp(80)
      );
    });

    // EC2 Instance
    new ec2.Instance(this, "Consumer EC2 Instance", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: consumerVPC,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: consumerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      securityGroup: consumerEC2InstanceSG,
      role: ssmIamRole,
    });

    const providerEC2Instance = new ec2.Instance(
      this,
      "Provider EC2 Instance",
      {
        instanceType: new ec2.InstanceType("t3.micro"),
        machineImage: ec2.MachineImage.latestAmazonLinux({
          generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        }),
        vpc: providerVPC,
        blockDevices: [
          {
            deviceName: "/dev/xvda",
            volume: ec2.BlockDeviceVolume.ebs(8, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
            }),
          },
        ],
        propagateTagsToVolumeOnCreation: true,
        vpcSubnets: providerVPC.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        }),
        securityGroup: providerEC2InstanceSG,
        role: ssmIamRole,
        userData: userDataProviderEC2Instance,
      }
    );

    // NLB
    const nlb = new elbv2.NetworkLoadBalancer(this, "NLB", {
      vpc: providerVPC,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      },
    });
    const nlbListener = nlb.addListener("NLB Listener", {
      port: 80,
    });
    nlbListener.addTargets("NLB Targets", {
      protocol: elbv2.Protocol.TCP,
      port: 80,
      targets: [new elbv2Targtes.InstanceTarget(providerEC2Instance, 80)],
    });

    const cfnNLB = nlb.node.defaultChild as elbv2.CfnLoadBalancer;
    cfnNLB.ipAddressType = "dualstack";

    // VPC Endpoint service
    const vpcEndpointService = new ec2.VpcEndpointService(
      this,
      "Endpoint Service",
      {
        vpcEndpointServiceLoadBalancers: [nlb],
        acceptanceRequired: false,
        allowedPrincipals: [
          new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
        ],
      }
    );

    // VPC Endpoint
    new ec2.InterfaceVpcEndpoint(this, "VPC Endpoint", {
      vpc: consumerVPC,
      service: new ec2.InterfaceVpcEndpointService(
        vpcEndpointService.vpcEndpointServiceName,
        80
      ),
      subnets: consumerVPC.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      securityGroups: [vpcEndpointSG],
    });
  }
}

// IPv6-enabled VPC
class IPv6Vpc extends ec2.Vpc {
  constructor(scope: Construct, id: string, props?: ec2.VpcProps) {
    super(scope, id, props);

    const ipv6CIDR = new ec2.CfnVPCCidrBlock(this, "IPv6 CIDR to VPC", {
      vpcId: this.vpcId,
      amazonProvidedIpv6CidrBlock: true,
    });

    const vpcIPv6CIDR = Fn.select(0, this.vpcIpv6CidrBlocks);
    const subnetIPv6CIDRs = Fn.cidr(vpcIPv6CIDR, 256, (128 - 64).toString());

    const allSubnets = [
      ...this.publicSubnets,
      ...this.privateSubnets,
      ...this.isolatedSubnets,
    ];

    // associate an IPv6 block to each subnets
    allSubnets.forEach((subnet, index) => {
      const subnetIPv6CIDR = Fn.select(index, subnetIPv6CIDRs);

      const cfnSubnet = subnet.node.defaultChild as ec2.CfnSubnet;
      cfnSubnet.ipv6CidrBlock = subnetIPv6CIDR;
      cfnSubnet.assignIpv6AddressOnCreation = true;
      cfnSubnet.addDependsOn(ipv6CIDR);
    });

    // for public subnets, ensure there is one IPv6 Internet Gateway
    if (this.publicSubnets) {
      this.publicSubnets.forEach((subnet) => {
        const publicSubnet = subnet as ec2.PublicSubnet;
        publicSubnet.addRoute("DefaultRouteIPv6", {
          routerType: ec2.RouterType.GATEWAY,
          routerId: this.internetGatewayId!,
          destinationIpv6CidrBlock: "::/0",
          enablesInternetConnectivity: true,
        });
      });
    }

    // for private subnet, ensure there is an IPv6 egress gateway
    if (this.privateSubnets) {
      const egressOnlyInternetGateway = new ec2.CfnEgressOnlyInternetGateway(
        this,
        "Egress-Only Internet Gateway",
        {
          vpcId: this.vpcId,
        }
      );

      this.privateSubnets.forEach((subnet) => {
        const privateSubnet = subnet as ec2.PrivateSubnet;
        privateSubnet.addRoute("DefaultRouteIPv6", {
          routerType: ec2.RouterType.EGRESS_ONLY_INTERNET_GATEWAY,
          routerId: egressOnlyInternetGateway.ref,
          destinationIpv6CidrBlock: "::/0",
          enablesInternetConnectivity: true,
        });
      });
    }
  }
}
